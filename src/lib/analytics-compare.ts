import { daysBetween } from "../../convex/lib/analytics";
import { addBusinessDays } from "../../convex/lib/time";

export type AnalyticsPeriod = "today" | "week" | "month" | "custom";

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The period a range is compared with (days are YYYY-MM-DD, Lubumbashi):
 * a day → the day before; a week so far → the same weekdays last week;
 * a month so far → the same days of last month (clamped to its length);
 * a custom range → the window of the same length just before it.
 */
export function previousRange(period: AnalyticsPeriod, from: string, to: string): { from: string; to: string } {
  if (period === "today") {
    const day = addBusinessDays(from, -1);
    return { from: day, to: day };
  }
  if (period === "week") return { from: addBusinessDays(from, -7), to: addBusinessDays(to, -7) };
  if (period === "month") {
    const [y, m] = from.split("-").map(Number);
    const year = m === 1 ? y - 1 : y;
    const month = m === 1 ? 12 : m - 1;
    const last = Math.min(Number(to.slice(8, 10)), daysInMonth(year, month));
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    return { from: `${prefix}-01`, to: `${prefix}-${String(last).padStart(2, "0")}` };
  }
  const length = daysBetween(from, to);
  const prevTo = addBusinessDays(from, -1);
  return { from: addBusinessDays(prevTo, -(length - 1)), to: prevTo };
}

/** Periods shorter than this aren't compared: a day or two swings too much to mean anything. */
export const MIN_COMPARE_DAYS = 3;

/**
 * The period to compare a range with, or null when the comparison would
 * mislead: the range is shorter than MIN_COMPARE_DAYS, or the period before
 * isn't the same length (e.g. 1-31 March vs 1-28 February).
 */
export function comparableRange(period: AnalyticsPeriod, from: string, to: string): { from: string; to: string } | null {
  const length = daysBetween(from, to);
  if (length < MIN_COMPARE_DAYS) return null;
  const previous = previousRange(period, from, to);
  return daysBetween(previous.from, previous.to) === length ? previous : null;
}

/**
 * Whether a change is good news, bad news or flat. For costs (`inverse`)
 * going down is good: a cost decrease is never shown as bad (red).
 */
export function deltaTone(pct: number, { inverse = false }: { inverse?: boolean } = {}): "good" | "bad" | "flat" {
  if (pct === 0) return "flat";
  return pct > 0 !== inverse ? "good" : "bad";
}

/** % change from `previous` to `current` (one decimal), or null when there's nothing to compare. */
export function percentChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}
