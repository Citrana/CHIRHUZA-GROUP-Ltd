import { expect, test } from "vitest";
import { DEFAULT_OPEN_DAYS, chartDays, classifyDays, cleanOpenDays, openDaysOf, weekdayOf } from "./salesDays";

// 2026-10-05 is a Monday; 2026-10-11 a Sunday.
const base = {
  from: "2026-10-05",
  to: "2026-10-12",
  today: "2026-10-12",
  openDays: DEFAULT_OPEN_DAYS,
  firstDay: "2026-10-05",
  soldDays: new Set(["2026-10-05", "2026-10-08"]),
  closedDays: new Set(["2026-10-09"]),
};
const statuses = (input: Parameters<typeof classifyDays>[0]) => classifyDays(input).map((d) => `${d.day.slice(8)} ${d.status}`);

test("a missing day is a past open day with no sale, not marked closed", () => {
  expect(statuses(base)).toEqual([
    "05 sale",
    "06 missing",
    "07 missing",
    "08 sale",
    "09 marked_closed",
    "10 missing",
    // Sunday: closed by default (Monday to Saturday).
    "11 closed_weekday",
    // Today isn't over: never flagged.
    "12 today",
  ]);
});

test("days before the shop's first sale, or a shop that never sold, aren't flagged", () => {
  expect(statuses({ ...base, firstDay: "2026-10-08" }).slice(0, 3)).toEqual(["05 sale", "06 before_start", "07 before_start"]);
  expect(statuses({ ...base, soldDays: new Set(), firstDay: null }).filter((s) => s.endsWith("missing"))).toEqual([]);
});

test("open days: a shop open every day flags the Sunday too", () => {
  expect(statuses({ ...base, openDays: [0, 1, 2, 3, 4, 5, 6] })).toContain("11 missing");
  expect(statuses({ ...base, openDays: [1, 2, 3, 4, 5] })).toContain("10 closed_weekday");
});

test("weekdays, defaults and cleaning", () => {
  expect([weekdayOf("2026-10-05"), weekdayOf("2026-10-11")]).toEqual([1, 0]);
  expect(openDaysOf({})).toEqual([1, 2, 3, 4, 5, 6]);
  expect(openDaysOf({ openDays: [0, 3] })).toEqual([0, 3]);
  expect(cleanOpenDays([6, 1, 1, 3])).toEqual([1, 3, 6]);
  expect(() => cleanOpenDays([])).toThrow();
  expect(() => cleanOpenDays([7])).toThrow();
  expect(() => cleanOpenDays([1.5])).toThrow();
});

test("chartDays: missing when any shop missed it, closed when no shop was open", () => {
  const a = { days: classifyDays(base) };
  const b = { days: classifyDays({ ...base, soldDays: new Set(["2026-10-06", "2026-10-07", "2026-10-10"]), closedDays: new Set() }) };
  const byDay = Object.fromEntries(chartDays([a, b]).map((d) => [d.day.slice(8), d]));
  expect(byDay["06"]).toMatchObject({ missing: true, closed: false });
  // Shop A marked the 9th closed but shop B missed it.
  expect(byDay["09"]).toMatchObject({ missing: true, closed: false });
  expect(byDay["11"]).toMatchObject({ missing: false, closed: true });
  expect(byDay["12"]).toMatchObject({ missing: false, closed: false });
});
