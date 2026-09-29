/**
 * Business time zone helpers (CLAUDE.md "Time"). Timestamps are stored as
 * UTC milliseconds; day/week/month bucketing happens in Africa/Lubumbashi.
 * Lubumbashi is UTC+2 all year (no daylight saving), so a fixed offset is
 * exact.
 */
export const BUSINESS_TIME_ZONE = "Africa/Lubumbashi";
const BUSINESS_UTC_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${day}".`);
  }
  const [, y, m, d] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

/** UTC ms of 00:00:00.000 on `day` (YYYY-MM-DD) in the business time zone. */
export function businessDayStartUtc(day: string): number {
  return parseDay(day) - BUSINESS_UTC_OFFSET_MS;
}

/** UTC ms of 23:59:59.999 on `day` (YYYY-MM-DD) in the business time zone. */
export function businessDayEndUtc(day: string): number {
  return businessDayStartUtc(day) + DAY_MS - 1;
}
