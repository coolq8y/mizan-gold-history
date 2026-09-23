import * as fs from "fs";
import { SharedGoldDailyEntry } from "./goldHistoryShared";

/**
 * Published artifact schema. Consumers use `days` and `updatedAt`; the remaining fields describe
 * coverage and persist updater state.
 * `backfillCursor` / `recentlyFailedDays` are resumable run-state — not meant for the app to read,
 * kept in the same committed file so a fresh CI checkout still knows where the last run left off
 * (this file IS the "save the previous output between runs" state, per design requirement #5).
 */
export interface StaticGoldHistoryFile {
  formatVersion: 1;
  source: string;
  updatedAt: string;
  coverage: { earliestDay: string | null; latestDay: string | null; totalDays: number };
  gaps: string[];
  days: Record<string, SharedGoldDailyEntry>;
  backfillCursor: { oldestCompletedDay: string | null; complete: boolean };
  recentlyFailedDays: Record<string, string>;
}

export const SOURCE_LABEL = "fawazahmed0/currency-api (CC0-1.0), via cdn.jsdelivr.net";
export const FORMAT_VERSION = 1;

export function emptyFile(): StaticGoldHistoryFile {
  return {
    formatVersion: FORMAT_VERSION,
    source: SOURCE_LABEL,
    updatedAt: new Date(0).toISOString(),
    coverage: { earliestDay: null, latestDay: null, totalDays: 0 },
    gaps: [],
    days: {},
    backfillCursor: { oldestCompletedDay: null, complete: false },
    recentlyFailedDays: {},
  };
}

/**
 * Reads the previously published file. Returns `{ file: null }` only when the path genuinely does
 * not exist yet (first-ever run). A path that exists but fails to parse is treated as FATAL by the
 * caller, not silently replaced with an empty state — losing a corrupted-but-recoverable file's
 * `days` map would look, to every client, exactly like a real data gap, and would also throw away
 * real backfill progress, forcing a full year of re-fetching. See updateGoldHistory.ts.
 */
export function readPreviousFile(path: string): { file: StaticGoldHistoryFile | null; parseError: string | null } {
  if (!fs.existsSync(path)) return { file: null, parseError: null };
  const raw = fs.readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as StaticGoldHistoryFile;
    const problems = structuralProblems(parsed);
    if (problems.length > 0) return { file: null, parseError: `existing file failed validation: ${problems.join("; ")}` };
    return { file: parsed, parseError: null };
  } catch (error) {
    return { file: null, parseError: `existing file is not valid JSON: ${(error as Error).message}` };
  }
}

/**
 * Structural sanity checks applied BEFORE ever writing a new version of the file — a run that
 * produces something failing these checks must NOT overwrite the last good file (design
 * requirement #6). Deliberately narrow: it checks shape/invariants, not "is every day present" —
 * missing days are an expected, honest gap, not a validation failure.
 */
export function structuralProblems(file: StaticGoldHistoryFile): string[] {
  const problems: string[] = [];
  if (file.formatVersion !== FORMAT_VERSION) problems.push(`unexpected formatVersion ${file.formatVersion}`);
  if (typeof file.updatedAt !== "string" || Number.isNaN(Date.parse(file.updatedAt))) problems.push("updatedAt is not a valid ISO instant");
  if (typeof file.days !== "object" || file.days === null) problems.push("days is missing or not an object");
  else {
    for (const [day, entry] of Object.entries(file.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) problems.push(`day key "${day}" is not yyyy-MM-dd`);
      if (typeof entry.xauUsdPerOunce !== "number" || !(entry.xauUsdPerOunce > 0)) problems.push(`${day}: xauUsdPerOunce is not a positive number`);
      if (typeof entry.rates !== "object" || entry.rates === null || Object.keys(entry.rates).length === 0) problems.push(`${day}: rates is missing or empty`);
    }
  }
  return problems;
}

/**
 * A new version must never REGRESS relative to the one it replaces — every day the old file had
 * must still be present (pruning trims the old end deliberately via `pruneOldDays`, which callers
 * apply to `next` before this check, so that expected trim never trips this). This is what stops a
 * partially-failed run from publishing a file that quietly has FEWER days than what is already
 * live — required by design requirement #6 ("never silently replace with an empty/incomplete
 * file").
 */
export function regressionProblems(previous: StaticGoldHistoryFile, next: StaticGoldHistoryFile, referenceISODate: string): string[] {
  const problems: string[] = [];
  const cutoff = new Date(referenceISODate);
  cutoff.setUTCDate(cutoff.getUTCDate() - ROLLING_WINDOW_DAYS);
  for (const day of Object.keys(previous.days)) {
    if (new Date(day) < cutoff) continue; // legitimately aged out of the rolling window, not a regression
    if (!(day in next.days)) problems.push(`day ${day} present in the previous file is missing from the new one`);
  }
  return problems;
}

export function writeFile(path: string, file: StaticGoldHistoryFile): void {
  // NOTE: JSON.stringify's array-form replacer is a recursive key WHITELIST, not just a top-level
  // sort order — passing top-level key names there would silently strip every nested `days`/
  // `rates` entry (their keys are dates/currency codes, never in that whitelist). Caught by a real
  // test (see test/update.test.js) that found the published file's `days` map coming back empty.
  fs.writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export function recomputeCoverage(file: StaticGoldHistoryFile): void {
  const days = Object.keys(file.days).sort();
  file.coverage = {
    earliestDay: days[0] ?? null,
    latestDay: days[days.length - 1] ?? null,
    totalDays: days.length,
  };
  if (days.length > 0) {
    const gaps: string[] = [];
    const cursor = new Date(days[0]);
    const end = new Date(days[days.length - 1]);
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      if (!file.days[iso]) gaps.push(iso);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    file.gaps = gaps;
  } else {
    file.gaps = [];
  }
}

/** Mirrors sharedGoldHistory.ts's ROLLING_WINDOW_DAYS — kept independent since this is a
 *  deliberately separate, simpler deployment target (see updateGoldHistory.ts's header comment). */
export const ROLLING_WINDOW_DAYS = 400;
export const BACKFILL_TARGET_DAYS = 366;
export const RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function pruneOldDays(file: StaticGoldHistoryFile, referenceISODate: string): void {
  const cutoff = new Date(referenceISODate);
  cutoff.setUTCDate(cutoff.getUTCDate() - ROLLING_WINDOW_DAYS);
  for (const iso of Object.keys(file.days)) {
    if (new Date(iso) < cutoff) delete file.days[iso];
  }
}
