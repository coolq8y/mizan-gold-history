/**
 * Backend-agnostic pieces of the shared gold history schema — deliberately has ZERO dependency on
 * Firebase, the Mizan iOS app, or any code outside this repository.
 */

/** The nine currencies included in the public feed. */
export const MIZAN_CURRENCY_CODES = ["KWD", "SAR", "AED", "QAR", "BHD", "OMR", "IQD", "JOD", "EGP"] as const;

export interface SharedGoldDailyEntry {
  /** USD price per troy ounce on this date — already inverted from the source's usd-per-XAU convention. */
  xauUsdPerOunce: number;
  /** Local-currency-per-USD rate for each Mizan currency, as published for this EXACT date. */
  rates: Record<string, number>;
}
