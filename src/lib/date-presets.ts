import { monthStart, weekStart } from "../../convex/lib/analytics";
import { addBusinessDays } from "../../convex/lib/time";

/**
 * Date shortcuts for list filters (FilterPanel's DateRangeFilter), as business days (Lubumbashi,
 * YYYY-MM-DD), like the analytics periods: weeks start on Monday, "this
 * week" and "this month" run up to today.
 */
export const DATE_PRESETS = ["today", "yesterday", "week", "month", "lastMonth"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

/** The from..to (inclusive) of a shortcut, given today's business day. */
export function presetRange(preset: DatePreset, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const day = addBusinessDays(today, -1);
      return { from: day, to: day };
    }
    case "week":
      return { from: weekStart(today), to: today };
    case "month":
      return { from: monthStart(today), to: today };
    case "lastMonth": {
      const lastDay = addBusinessDays(monthStart(today), -1);
      return { from: monthStart(lastDay), to: lastDay };
    }
  }
}

/** The shortcut whose range is exactly from..to, or null (a hand-picked range). */
export function matchingPreset(from: string, to: string, today: string): DatePreset | null {
  return (
    DATE_PRESETS.find((preset) => {
      const range = presetRange(preset, today);
      return range.from === from && range.to === to;
    }) ?? null
  );
}

/** What a date filter's chip says: a shortcut's name, one day, a range or one open end. */
export type DateRangeChip =
  | { kind: "preset"; preset: DatePreset }
  | { kind: "day"; day: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "from"; from: string }
  | { kind: "to"; to: string };

export function dateRangeChip(from: string, to: string, today: string): DateRangeChip | null {
  const preset = matchingPreset(from, to, today);
  if (preset) return { kind: "preset", preset };
  if (from && to) return from === to ? { kind: "day", day: from } : { kind: "range", from, to };
  if (from) return { kind: "from", from };
  if (to) return { kind: "to", to };
  return null;
}
