import { MIZAN_CURRENCY_CODES, SharedGoldDailyEntry } from "./goldHistoryShared";

/**
 * One real snapshot for `isoDate`, primary host then the documented Cloudflare Pages fallback —
 * The primary host has a documented Cloudflare Pages fallback. This throws on any failure
 * (network, non-200, missing xau/currency fields) — the caller is responsible for
 * treating that as "not available yet, try again later," never fabricating a value.
 */
export async function fetchDailySnapshot(isoDate: string): Promise<SharedGoldDailyEntry> {
  const primary = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${isoDate}/v1/currencies/usd.min.json`;
  const fallback = `https://${isoDate}.currency-api.pages.dev/v1/currencies/usd.min.json`;
  let payload: { usd: Record<string, number> };
  try {
    payload = await fetchJSON(primary);
  } catch {
    payload = await fetchJSON(fallback);
  }
  const inverseGoldOunces = payload.usd["xau"];
  if (!inverseGoldOunces || inverseGoldOunces <= 0) throw new Error(`no xau field for ${isoDate}`);
  const xauUsdPerOunce = 1 / inverseGoldOunces;
  const rates: Record<string, number> = {};
  for (const code of MIZAN_CURRENCY_CODES) {
    const rate = payload.usd[code.toLowerCase()];
    if (rate && rate > 0) rates[code] = rate;
  }
  if (Object.keys(rates).length === 0) throw new Error(`no known currency rates for ${isoDate}`);
  return { xauUsdPerOunce, rates };
}

async function fetchJSON(url: string): Promise<{ usd: Record<string, number> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return (await response.json()) as { usd: Record<string, number> };
  } finally {
    clearTimeout(timeout);
  }
}

/** UTC yyyy-MM-dd used by the upstream daily-snapshot URLs and the public file. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
