// Executed Node tests for the static-JSON update path. They use deterministic fetch doubles, so
// the suite needs no network, cloud service, or emulator. Run with `npm test` (builds first).
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runUpdate, setTestTuning } = require("../dist/updateGoldHistory");
const {
  emptyFile,
  readPreviousFile,
  writeFile,
  structuralProblems,
  regressionProblems,
} = require("../dist/fileGoldHistory");

setTestTuning(6, 0); // small batches, no artificial delay — real algorithm, fast test run

let passed = 0;
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (error) {
      console.error(`  FAIL - ${name}`);
      console.error(error);
      process.exitCode = 1;
    }
  })();
}

function fakeEntry(day) {
  // Deterministic, distinguishable-per-day fake data — never a real network call.
  const n = new Date(day).getTime() / 86400000;
  return { xauUsdPerOunce: 2000 + (n % 50), rates: { KWD: 0.3, SAR: 3.75 } };
}

function makeFetch({ fail = new Set() } = {}) {
  return async (day) => {
    if (fail.has(day)) throw new Error(`simulated failure for ${day}`);
    return fakeEntry(day);
  };
}

async function main() {
  await check("daily top-up fetches only missing trailing days, never re-fetches present ones", async () => {
    const now = new Date("2026-02-05T03:00:00.000Z"); // batch size 6 from setTestTuning above
    const requested = [];
    const fetch = async (day) => {
      requested.push(day);
      return fakeEntry(day);
    };
    const base = emptyFile();
    base.days["2026-02-04"] = fakeEntry("2026-02-04");
    const { next, written } = await runUpdate(base, now, fetch);
    assert.ok(!requested.includes("2026-02-04"), "already-present day must not be re-fetched");
    for (const d of ["2026-02-01", "2026-02-02", "2026-02-03", "2026-02-05"]) {
      assert.ok(next.days[d], `expected ${d} to be filled in by the trailing top-up`);
    }
    // 4 genuinely missing trailing days + a 6-day backfill batch on older, also-genuinely-missing days.
    assert.strictEqual(written.length, 10, `expected 10 total fetched days, got ${written.length}`);
  });

  await check("real Jan 29 spike survives the file and is retrievable exactly", async () => {
    const now = new Date("2026-01-30T01:00:00.000Z");
    const fetch = async (day) => {
      if (day === "2026-01-29") return { xauUsdPerOunce: 5539.35 /* -> ~54.5834 KWD/g, matches CoreRegressionTests */, rates: { KWD: 0.3068 } };
      return fakeEntry(day);
    };
    const base = emptyFile();
    const { next } = await runUpdate(base, now, fetch);
    assert.ok(next.days["2026-01-29"], "Jan 29 entry missing");
    assert.strictEqual(next.days["2026-01-29"].xauUsdPerOunce, 5539.35);
  });

  await check("a day that fails is retried after the cooldown, not before", async () => {
    const t1 = new Date("2026-03-01T02:00:00.000Z");
    const failing = new Set(["2026-02-28"]);
    const base = emptyFile();
    const r1 = await runUpdate(base, t1, makeFetch({ fail: failing }));
    assert.ok(!r1.next.days["2026-02-28"]);
    assert.ok(r1.next.recentlyFailedDays["2026-02-28"]);

    const tSoon = new Date(t1.getTime() + 60 * 60 * 1000); // 1h later, cooldown is 6h
    const r2 = await runUpdate(r1.next, tSoon, makeFetch({}));
    assert.ok(!r2.next.days["2026-02-28"], "should still be cooling down, not retried yet");

    const tLater = new Date(t1.getTime() + 7 * 60 * 60 * 1000); // 7h later, past cooldown
    const r3 = await runUpdate(r2.next, tLater, makeFetch({}));
    assert.ok(r3.next.days["2026-02-28"], "should have been retried and succeeded after cooldown");
  });

  await check("resumable backfill cursor advances across multiple runs and never restarts from scratch", async () => {
    setTestTuning(5, 0);
    const now = new Date("2026-04-01T00:00:00.000Z");
    let state = emptyFile();
    let totalFetched = 0;
    const fetch = async (day) => {
      totalFetched++;
      return fakeEntry(day);
    };
    let complete = false;
    let iterations = 0;
    while (!complete && iterations < 200) {
      const r = await runUpdate(state, now, fetch);
      state = r.next;
      complete = state.backfillCursor.complete;
      iterations++;
    }
    assert.ok(complete, "backfill did not complete within a reasonable number of runs");
    assert.ok(state.coverage.totalDays >= 366, `expected >=366 days backfilled, got ${state.coverage.totalDays}`);

    // Continuing after completion must be a no-op for the backfill portion (only the 5-day
    // trailing top-up may touch already-covered ground, and even that re-fetches nothing present).
    const beforeDays = state.coverage.totalDays;
    const r2 = await runUpdate(state, new Date(now.getTime() + 86400000), fetch);
    assert.ok(r2.next.backfillCursor.complete);
    // one new trailing day may be added by the daily top-up as "now" advanced by a day
    assert.ok(r2.next.coverage.totalDays <= beforeDays + 1);
  });

  await check("previously-fetched days are never re-requested across a fresh run built from the persisted file", async () => {
    setTestTuning(50, 0);
    const now = new Date("2026-05-01T00:00:00.000Z");
    let callCount = 0;
    const fetch = async (day) => {
      callCount++;
      return fakeEntry(day);
    };
    const r1 = await runUpdate(emptyFile(), now, fetch);
    const firstRunCalls = callCount;
    assert.ok(firstRunCalls > 0);

    // Simulate a FRESH CI checkout: persist r1.next to disk, then read it back exactly like main() does.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizan-cf-test-"));
    const filePath = path.join(tmpDir, "gold-history.json");
    writeFile(filePath, r1.next);
    const { file: reloaded, parseError } = readPreviousFile(filePath);
    assert.strictEqual(parseError, null);
    assert.deepStrictEqual(Object.keys(reloaded.days).sort(), Object.keys(r1.next.days).sort());

    const requestedOnRerun = [];
    const trackingFetch = async (day) => {
      requestedOnRerun.push(day);
      return fakeEntry(day);
    };
    const alreadyCovered = new Set(Object.keys(reloaded.days));
    const r2 = await runUpdate(reloaded, new Date(now.getTime() + 15 * 60 * 1000), trackingFetch); // 15 min later
    // The backfill cursor legitimately continues into NEW ground (proving it didn't restart from
    // day zero) — what must never happen is re-requesting a day this run already has on disk.
    const duplicates = requestedOnRerun.filter((d) => alreadyCovered.has(d));
    assert.strictEqual(duplicates.length, 0, `re-fetched already-covered day(s): ${duplicates.join(", ")}`);
    assert.ok(r2.next.backfillCursor.oldestCompletedDay < reloaded.backfillCursor.oldestCompletedDay || r2.next.backfillCursor.complete, "backfill cursor should have advanced further back, not restarted");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await check("a corrupted existing file is reported as a parse error, never silently treated as empty", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizan-cf-test-"));
    const filePath = path.join(tmpDir, "gold-history.json");
    fs.writeFileSync(filePath, "{ this is not valid json", "utf8");
    const { file, parseError } = readPreviousFile(filePath);
    assert.strictEqual(file, null);
    assert.ok(parseError && parseError.includes("not valid JSON"));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await check("a structurally invalid file (bad entry) is also rejected, not silently accepted", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizan-cf-test-"));
    const filePath = path.join(tmpDir, "gold-history.json");
    const bad = emptyFile();
    bad.days["2026-01-01"] = { xauUsdPerOunce: -5, rates: {} };
    fs.writeFileSync(filePath, JSON.stringify(bad), "utf8");
    const { file, parseError } = readPreviousFile(filePath);
    assert.strictEqual(file, null);
    assert.ok(parseError && parseError.includes("failed validation"));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await check("regressionProblems flags a new version that drops a day the old one had (outside the prune window)", async () => {
    const now = "2026-06-01";
    const previous = emptyFile();
    previous.days["2026-05-30"] = fakeEntry("2026-05-30");
    const next = emptyFile();
    // next is missing 2026-05-30 entirely — must be flagged, since that day is nowhere near the
    // 400-day rolling-window cutoff and its disappearance can only mean a bad run.
    const problems = regressionProblems(previous, next, now);
    assert.ok(problems.some((p) => p.includes("2026-05-30")));
  });

  await check("regressionProblems does NOT flag a day that legitimately aged out of the rolling window", async () => {
    const now = "2027-06-01"; // 516 days after 2026-01-01, well past the 400-day rolling window
    const previous = emptyFile();
    previous.days["2026-01-01"] = fakeEntry("2026-01-01");
    const next = emptyFile(); // correctly pruned away
    const problems = regressionProblems(previous, next, now);
    assert.strictEqual(problems.length, 0);
  });

  await check("structuralProblems catches an empty rates map", async () => {
    const f = emptyFile();
    f.days["2026-01-01"] = { xauUsdPerOunce: 2000, rates: {} };
    const problems = structuralProblems(f);
    assert.ok(problems.some((p) => p.includes("rates")));
  });

  await check("coverage/gaps are recomputed to reflect real missing days honestly, never fabricated", async () => {
    setTestTuning(50, 0);
    const now = new Date("2026-07-10T00:00:00.000Z");
    const failing = new Set(["2026-07-08"]);
    const { next } = await runUpdate(emptyFile(), now, makeFetch({ fail: failing }));
    assert.ok(next.gaps.includes("2026-07-08"), "the known-failed day should show up as an honest gap");
    assert.ok(!next.days["2026-07-08"], "a gap day must never have a fabricated entry");
  });

  console.log(`\n${passed} passing`);
  if (process.exitCode) {
    console.error("Some tests FAILED");
    process.exit(1);
  }
}

main();
