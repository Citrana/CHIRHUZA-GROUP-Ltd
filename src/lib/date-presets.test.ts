import { expect, test } from "vitest";
import { dateRangeChip, matchingPreset, presetRange } from "./date-presets";

test("each shortcut on a mid-month Wednesday", () => {
  const today = "2026-10-14"; // Wednesday
  expect(presetRange("today", today)).toEqual({ from: "2026-10-14", to: "2026-10-14" });
  expect(presetRange("yesterday", today)).toEqual({ from: "2026-10-13", to: "2026-10-13" });
  expect(presetRange("week", today)).toEqual({ from: "2026-10-12", to: "2026-10-14" });
  expect(presetRange("month", today)).toEqual({ from: "2026-10-01", to: "2026-10-14" });
  expect(presetRange("lastMonth", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
});

test("month boundaries: on the 1st, yesterday is last month's last day", () => {
  expect(presetRange("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
  expect(presetRange("month", "2026-03-01")).toEqual({ from: "2026-03-01", to: "2026-03-01" });
  expect(presetRange("lastMonth", "2028-03-01")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
});

test("last month across a year boundary", () => {
  expect(presetRange("lastMonth", "2027-01-10")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
});

test("this week starts on Monday, also on a Monday and a Sunday", () => {
  expect(presetRange("week", "2026-10-12")).toEqual({ from: "2026-10-12", to: "2026-10-12" }); // Monday
  expect(presetRange("week", "2026-10-18")).toEqual({ from: "2026-10-12", to: "2026-10-18" }); // Sunday
});

test("matchingPreset recognises a shortcut's range, not a hand-picked one", () => {
  const today = "2026-10-14";
  expect(matchingPreset("2026-10-14", "2026-10-14", today)).toBe("today");
  expect(matchingPreset("2026-09-01", "2026-09-30", today)).toBe("lastMonth");
  expect(matchingPreset("2026-10-02", "2026-10-14", today)).toBeNull();
  expect(matchingPreset("", "", today)).toBeNull();
});

test("dateRangeChip: a shortcut's name, one day, a range or one open end", () => {
  const today = "2026-10-14";
  expect(dateRangeChip("2026-10-12", "2026-10-14", today)).toEqual({ kind: "preset", preset: "week" });
  expect(dateRangeChip("2026-10-02", "2026-10-02", today)).toEqual({ kind: "day", day: "2026-10-02" });
  expect(dateRangeChip("2026-10-02", "2026-10-09", today)).toEqual({ kind: "range", from: "2026-10-02", to: "2026-10-09" });
  expect(dateRangeChip("2026-10-02", "", today)).toEqual({ kind: "from", from: "2026-10-02" });
  expect(dateRangeChip("", "2026-10-09", today)).toEqual({ kind: "to", to: "2026-10-09" });
  expect(dateRangeChip("", "", today)).toBeNull();
});
