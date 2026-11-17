import { describe, expect, test } from "vitest";
import {
  approvalAmount,
  cleanSections,
  financeFiguresOf,
  groupDayRanges,
  reorderQty,
  reportHighlights,
  compareRangeFor,
  contentFor,
  customRange,
  nextRunAt,
  parseTime,
  periodFor,
  visibleSections,
  type ReportContent,
  type Schedule,
} from "./reports";
import { businessDayStartUtc } from "./time";

// 2026-11-15 is a Sunday; 2026-11-18 a Wednesday.
const at = (day: string, hhmm: string) => businessDayStartUtc(day) + (parseTime(hhmm) ?? 0) * 60_000;
const weekly: Schedule = { frequency: "weekly", dayOfWeek: 0, dayOfMonth: 1, time: "09:00" };

describe("periodFor", () => {
  test("weekly on a Sunday covers that week's Monday to Sunday", () => {
    expect(periodFor("weekly", "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });
  test("weekly on another day covers the last full week", () => {
    expect(periodFor("weekly", "2026-11-18")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(periodFor("weekly", "2026-11-16")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });
  test("daily covers the day before; monthly the previous month", () => {
    expect(periodFor("daily", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(periodFor("monthly", "2026-03-05")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodFor("monthly", "2026-01-01")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("compareRangeFor", () => {
  test("compares with the previous period of the same length", () => {
    expect(compareRangeFor("2026-11-09", "2026-11-15")).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(compareRangeFor("2026-02-01", "2026-02-28")).toEqual({ from: "2026-01-04", to: "2026-01-31" });
  });
  test("a day or two isn't compared", () => {
    expect(compareRangeFor("2026-11-15", "2026-11-15")).toBeNull();
    expect(compareRangeFor("2026-11-14", "2026-11-15")).toBeNull();
  });
});

describe("nextRunAt", () => {
  test("default: next Sunday 09:00 Lubumbashi", () => {
    expect(nextRunAt(weekly, at("2026-11-18", "12:00"))).toBe(at("2026-11-22", "09:00"));
    // Sunday before 09:00 -> that same morning; at 09:00 -> next week.
    expect(nextRunAt(weekly, at("2026-11-15", "08:45"))).toBe(at("2026-11-15", "09:00"));
    expect(nextRunAt(weekly, at("2026-11-15", "09:00"))).toBe(at("2026-11-22", "09:00"));
  });
  test("09:00 Lubumbashi is 07:00 UTC", () => {
    expect(new Date(nextRunAt(weekly, at("2026-11-18", "12:00"))).toISOString()).toBe("2026-11-22T07:00:00.000Z");
  });
  test("daily and monthly cross day, month and year ends", () => {
    const daily: Schedule = { ...weekly, frequency: "daily", time: "06:30" };
    expect(nextRunAt(daily, at("2026-12-31", "07:00"))).toBe(at("2027-01-01", "06:30"));
    const monthly: Schedule = { ...weekly, frequency: "monthly", dayOfMonth: 28 };
    expect(nextRunAt(monthly, at("2026-11-28", "10:00"))).toBe(at("2026-12-28", "09:00"));
    expect(nextRunAt(monthly, at("2027-02-01", "10:00"))).toBe(at("2027-02-28", "09:00"));
  });
});

test("times must be quarter hours", () => {
  expect(parseTime("09:00")).toBe(540);
  expect(parseTime("23:45")).toBe(1425);
  expect(parseTime("09:10")).toBeNull();
  expect(parseTime("24:00")).toBeNull();
  expect(parseTime("9:00")).toBeNull();
});

test("custom range: at most 12 months, never in the future", () => {
  const now = at("2026-11-17", "10:00");
  expect(customRange("2025-11-17", "2026-11-17", now)).toEqual({ from: "2025-11-17", to: "2026-11-17" });
  expect(() => customRange("2025-11-15", "2026-11-17", now)).toThrow(/366/);
  expect(() => customRange("2026-11-01", "2026-11-18", now)).toThrow(/future/);
  expect(() => customRange("2026-11-10", "2026-11-01", now)).toThrow(/before/);
});

test("sections: catalogue order, at least one; cash only for cash.view", () => {
  expect(cleanSections(["cash", "sales", "sales"])).toEqual(["sales", "cash"]);
  expect(() => cleanSections([])).toThrow(/at least one/);
  const noCash = () => false;
  expect(visibleSections(["sales", "cash"], noCash)).toEqual(["sales"]);
  const content: ReportContent = {
    sales: { total: 1, previousTotal: null, compareFrom: null, compareTo: null, currency: "USD" },
    cash: { onHand: 5, pendingOpeningCash: 0, pendingOpeningCashCount: 0, currency: "USD" },
  };
  expect(contentFor(content, noCash)).toEqual({ sales: content.sales });
  expect(contentFor(content, () => true)).toEqual(content);
});

test("consecutive days become ranges", () => {
  expect(groupDayRanges(["2026-11-12", "2026-11-10", "2026-11-11", "2026-11-15", "2026-11-30", "2026-12-01"])).toEqual([
    { from: "2026-11-10", to: "2026-11-12" },
    { from: "2026-11-15", to: "2026-11-15" },
    { from: "2026-11-30", to: "2026-12-01" },
  ]);
  expect(groupDayRanges([])).toEqual([]);
});

test("reorder covers 30 days of sales, at least the low-stock level, never below 0", () => {
  expect(reorderQty(12, 5, 2)).toBe(10); // sales-based
  expect(reorderQty(1, 10, 3)).toBe(7); // low-stock level
  expect(reorderQty(4, undefined, 0)).toBe(4);
  expect(reorderQty(3, 2, 9)).toBe(0); // enough on hand
});

test("an approval's amount comes from its payload's money field", () => {
  expect(approvalAmount({ after: { amount: 700, currency: "USD" } })).toEqual({ amount: 700, currency: "USD" });
  expect(approvalAmount({ after: { unitCost: 5, purchasedTotal: 900, currency: "CDF" } })).toEqual({ amount: 900, currency: "CDF" });
  expect(approvalAmount({ before: { x: 1 }, refundAmount: 300 })).toEqual({ amount: 300, currency: "USD" });
  expect(approvalAmount({ after: { name: "Bob" } })).toBeNull();
  expect(approvalAmount(null)).toBeNull();
});

test("finance figures: margin, net profit = margin - expenses - payroll, withdrawals apart", () => {
  const row = { sales: 1000, saleCost: 400, expenses: 100, payroll: 200, withdrawals: 50 };
  expect(financeFiguresOf([row, row])).toEqual({ sales: 2000, margin: 1200, expenses: 200, payroll: 400, netProfit: 600, withdrawals: 100 });
});

describe("reportHighlights", () => {
  const sales = (total: number, previousTotal: number | null) => ({
    total,
    previousTotal,
    compareFrom: null,
    compareTo: null,
    currency: "USD" as const,
  });
  const item = (reorderQty: number) => ({
    productId: "p" as never,
    name: "P",
    sku: "S",
    lengthInches: null,
    sizeName: null,
    colourName: null,
    onHand: 0,
    outOfStockSince: null,
    sold30: 0,
    reorderQty,
  });

  test("one line per section, at most 4, in order", () => {
    const lines = reportHighlights({
      sales: sales(1200, 1000),
      missingDays: { count: 3, shops: [{ locationId: "l" as never, name: "A", days: [] }] },
      stock: { lowCount: 1, outCount: 1, low: [item(4)], out: [item(0)] },
      credit: { totalOwed: 500, customers: 2, top: [{ customerId: "c" as never, name: "C", balance: 500, daysUnpaid: 9 }], currency: "USD" },
    });
    expect(lines).toEqual([
      { key: "salesUp", values: { amount: 1200, pct: 20 } },
      { key: "missing", values: { days: 3, shops: 1 } },
      { key: "reorder", values: { products: 1, units: 4 } },
      { key: "owed", values: { amount: 500, customers: 2, days: 9 } },
    ]);
  });

  test("no trend without a previous period; good news lines; missing sections skipped", () => {
    expect(reportHighlights({ sales: { ...sales(800, null), missingDaysCount: 0 } })).toEqual([
      { key: "salesTotal", values: { amount: 800 } },
      { key: "noMissing", values: {} },
    ]);
    expect(reportHighlights({ sales: sales(500, 1000) })[0]).toEqual({ key: "salesDown", values: { amount: 500, pct: 50 } });
    expect(reportHighlights({ credit: { totalOwed: 0, customers: 0, top: [], currency: "USD" } })).toEqual([{ key: "noOwed", values: {} }]);
  });
});
