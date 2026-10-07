import { expect, test } from "vitest";
import { percentChange, previousRange } from "./analytics-compare";

test("previousRange: day, week, month to date, custom", () => {
  expect(previousRange("today", "2026-10-07", "2026-10-07")).toEqual({ from: "2026-10-06", to: "2026-10-06" });
  // Mon 5 Oct → Wed 7 Oct compares with Mon 28 Sep → Wed 30 Sep.
  expect(previousRange("week", "2026-10-05", "2026-10-07")).toEqual({ from: "2026-09-28", to: "2026-09-30" });
  expect(previousRange("month", "2026-10-01", "2026-10-07")).toEqual({ from: "2026-09-01", to: "2026-09-07" });
  // 31 Oct → September has 30 days; January → December of the year before.
  expect(previousRange("month", "2026-10-01", "2026-10-31")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  expect(previousRange("month", "2027-01-01", "2027-01-15")).toEqual({ from: "2026-12-01", to: "2026-12-15" });
  // Custom 10 days (Oct 1-10) → the 10 days before (Sep 21-30).
  expect(previousRange("custom", "2026-10-01", "2026-10-10")).toEqual({ from: "2026-09-21", to: "2026-09-30" });
});

test("percentChange: one decimal, null when nothing to compare", () => {
  expect(percentChange(120, 100)).toBe(20);
  expect(percentChange(80, 100)).toBe(-20);
  expect(percentChange(50, -100)).toBe(150);
  expect(percentChange(1, 3)).toBe(-66.7);
  expect(percentChange(100, 0)).toBeNull();
  expect(percentChange(100, null)).toBeNull();
});
