import * as path from "path";
import { fetchDailySnapshot as defaultFetch, isoDay } from "./fawazahmed0";
import { SharedGoldDailyEntry } from "./goldHistoryShared";
import {
  StaticGoldHistoryFile,
  emptyFile,
  readPreviousFile,
  structuralProblems,
  regressionProblems,
  writeFile,
  recomputeCoverage,
  pruneOldDays,
  BACKFILL_TARGET_DAYS,
  RETRY_COOLDOWN_MS,
} from "./fileGoldHistory";

export type FetchFn = (isoDate: string) => Promise<SharedGoldDailyEntry>;

/** Days fetched per invocation for the backfill portion — a small, polite batch size and
 *  spacing are used so a scheduled run
 *  every so often, never a burst of "hundreds of requests" in one go (design constraint, repeated
 *  by the user across this whole feature). Overridable so tests don't wait real time. */
export let BATCH_SIZE = 24;
export let REQUEST_SPACING_MS = 250;
export function setTestTuning(batchSize: number, requestSpacingMs: number): void {
  BATCH_SIZE = batchSize;
  REQUEST_SPACING_MS = requestSpacingMs;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function earlierDay(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * One run covers both jobs needed by the feed: top up the last few trailing dates in case a daily
 * snapshot appeared late, then advance the resumable backfill cursor by one bounded batch. The
 * workflow serializes runs, so there is only one file writer at a time.
 */
export async function runUpdate(
  previous: StaticGoldHistoryFile,
  now: Date,
  fetch: FetchFn = defaultFetch
): Promise<{ next: StaticGoldHistoryFile; written: string[]; failed: string[] }> {
  const next: StaticGoldHistoryFile = JSON.parse(JSON.stringify(previous));
  const nowISO = now.toISOString();
  const written: string[] = [];
  const failed: string[] = [];

  // --- Daily top-up: re-check a small trailing window, same as dailyGoldHistoryUpdate.ts ---
  const candidates: string[] = [];
  for (let offset = 0; offset < 5; offset++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - offset);
    candidates.push(isoDay(d));
  }
  for (const day of candidates) {
    if (next.days[day]) continue;
    const failedAt = next.recentlyFailedDays[day];
    if (failedAt && now.getTime() - new Date(failedAt).getTime() < RETRY_COOLDOWN_MS) continue;
    try {
      next.days[day] = await fetch(day);
      delete next.recentlyFailedDays[day];
      written.push(day);
    } catch (error) {
      next.recentlyFailedDays[day] = nowISO;
      failed.push(day);
      console.warn(`[updateGoldHistory] daily top-up: ${day} still unavailable: ${(error as Error).message}`);
    }
  }

  // --- Resumable backfill: one bounded batch, same as backfillHistoricalGold.ts ---
  if (!next.backfillCursor.complete) {
    const startFrom = next.backfillCursor.oldestCompletedDay ? new Date(next.backfillCursor.oldestCompletedDay) : new Date(now);
    if (!next.backfillCursor.oldestCompletedDay) startFrom.setUTCDate(startFrom.getUTCDate() - 1);
    const target = new Date(now);
    target.setUTCDate(target.getUTCDate() - BACKFILL_TARGET_DAYS);

    const cursor = new Date(startFrom);
    let processed = 0;
    let oldestReachedThisRun = next.backfillCursor.oldestCompletedDay;
    while (processed < BATCH_SIZE && cursor >= target) {
      const day = isoDay(cursor);
      if (next.days[day]) {
        oldestReachedThisRun = day;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
        continue;
      }
      const failedAt = next.recentlyFailedDays[day];
      const stillCoolingDown = failedAt && now.getTime() - new Date(failedAt).getTime() < RETRY_COOLDOWN_MS;
      if (!stillCoolingDown) {
        try {
          next.days[day] = await fetch(day);
          delete next.recentlyFailedDays[day];
          written.push(day);
        } catch (error) {
          next.recentlyFailedDays[day] = nowISO;
          failed.push(day);
          console.warn(`[updateGoldHistory] backfill: ${day} unavailable: ${(error as Error).message}`);
        }
        processed++;
        if (REQUEST_SPACING_MS > 0) await sleep(REQUEST_SPACING_MS);
      }
      oldestReachedThisRun = day;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    const reachedTarget = cursor < target;
    next.backfillCursor.oldestCompletedDay = earlierDay(next.backfillCursor.oldestCompletedDay, oldestReachedThisRun);
    next.backfillCursor.complete = next.backfillCursor.complete || reachedTarget;
  }

  pruneOldDays(next, isoDay(now));
  recomputeCoverage(next);
  next.updatedAt = nowISO;
  return { next, written, failed };
}

async function main(): Promise<void> {
  // The npm scripts run from the repository root, so the public artifact is cwd-relative.
  const outPath = process.argv[2] ?? path.join(process.cwd(), "public", "gold-history.json");
  const now = new Date();

  const { file: previous, parseError } = readPreviousFile(outPath);
  if (parseError) {
    // Fatal on purpose: writing an empty file here would look, to every client, like a real
    // multi-hundred-day data gap, and would also throw away real backfill progress (forcing a
    // full year of re-fetching). Leave the last-published file exactly as it is and fail the CI
    // run loudly instead — design requirement #6.
    console.error(`[updateGoldHistory] FATAL: ${parseError}. Refusing to touch ${outPath}.`);
    process.exit(1);
  }
  const base = previous ?? emptyFile();

  const { next, written, failed } = await runUpdate(base, now);

  const structural = structuralProblems(next);
  const regressions = previous ? regressionProblems(previous, next, isoDay(now)) : [];
  const problems = [...structural, ...regressions];
  if (problems.length > 0) {
    console.error(`[updateGoldHistory] FATAL: refusing to publish an invalid update to ${outPath}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  writeFile(outPath, next);
  console.log(
    `[updateGoldHistory] wrote ${outPath}: ${next.coverage.totalDays} days ` +
      `(${next.coverage.earliestDay} .. ${next.coverage.latestDay}), ${next.gaps.length} gap(s), ` +
      `backfill ${next.backfillCursor.complete ? "complete" : "in progress (cursor " + next.backfillCursor.oldestCompletedDay + ")"}. ` +
      `This run: ${written.length} day(s) written, ${failed.length} failed.`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[updateGoldHistory] FATAL: unexpected error", error);
    process.exit(1);
  });
}
