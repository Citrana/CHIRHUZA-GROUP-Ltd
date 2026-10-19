import { expect, test } from "vitest";
import {
  DEFAULT_FILTERS,
  SHOWS,
  businessDaysAgo,
  effectivePeriod,
  filterReportRows,
  matchesShow,
  neverSold,
  parseStockFilters,
  sellThrough,
  stockFiltersQuery,
} from "./stock-movement";

const row = (received: number, sold: number, soldInPeriod: number, onHand: number) => ({ received, sold, soldInPeriod, onHand });

test("the rate is sold in the period over bought in", () => {
  expect(sellThrough(row(20, 12, 10, 8))).toBe(0.5);
  expect(sellThrough(row(0, 0, 0, 0))).toBeNull();
});

test("show choices: selling well, slowly, not selling - never more than one", () => {
  const shows = (r: ReturnType<typeof row>) => SHOWS.filter((m) => matchesShow(r, m));
  // Selling well: half or more of what came in sold in the period.
  expect(shows(row(20, 12, 10, 8))).toEqual(["well"]);
  // Selling slowly: some left, some sold, under 20%.
  expect(shows(row(20, 3, 3, 17))).toEqual(["slow"]);
  // Not selling: some left and nothing sold in the period...
  expect(shows(row(10, 4, 0, 6))).toEqual(["not_selling"]);
  // ...or bought in and never sold.
  expect(shows(row(10, 0, 0, 10))).toEqual(["not_selling"]);
  expect(neverSold(row(10, 0, 0, 10))).toBe(true);
  // In between, sold out, or never bought in: none of them.
  expect(shows(row(20, 6, 6, 14))).toEqual([]);
  expect(shows(row(20, 20, 3, 0))).toEqual([]);
  expect(shows(row(0, 0, 0, 0))).toEqual([]);
});

test("filters round-trip through the URL, defaults left out", () => {
  expect(stockFiltersQuery(DEFAULT_FILTERS)).toBe("");
  const filters = { ...DEFAULT_FILTERS, status: "available" as const, show: "slow" as const, period: "90" as const, sort: "sold" as const, desc: false };
  const query = stockFiltersQuery(filters);
  expect(query).toBe("status=available&show=slow&period=90&sort=sold&dir=asc");
  expect(parseStockFilters(new URLSearchParams(query))).toEqual(filters);
  // Home's links, older links and junk values.
  expect(parseStockFilters(new URLSearchParams("status=out")).status).toBe("out");
  expect(parseStockFilters(new URLSearchParams("status=in_stock")).status).toBe("available");
  expect(parseStockFilters(new URLSearchParams("status=x&period=7&sort=y&show=z"))).toEqual(DEFAULT_FILTERS);
});

test("the period only applies with a show choice", () => {
  expect(effectivePeriod({ ...DEFAULT_FILTERS, period: "90" })).toBe("all");
  expect(effectivePeriod({ ...DEFAULT_FILTERS, show: "well", period: "90" })).toBe("90");
});

test("days ago count business days (Africa/Lubumbashi)", () => {
  const now = Date.UTC(2026, 9, 19, 10); // 12:00 in Lubumbashi
  expect(businessDaysAgo(now, now)).toBe(0);
  expect(businessDaysAgo(Date.UTC(2026, 9, 18, 23), now)).toBe(0); // 01:00 on the 19th locally
  expect(businessDaysAgo(Date.UTC(2026, 9, 15, 10), now)).toBe(4);
});

test("report filters combine, counts are faceted, sorting puts empty values last", () => {
  const r = (name: string, status: "in_stock" | "low" | "out" | "never", received: number, sold: number, soldInPeriod: number, onHand: number, lastSoldAt: number | null) => ({
    name, status, received, sold, soldInPeriod, onHand, lastSoldAt, sku: `SKU-${name}`, lengthInches: null, sizeName: null, colourName: "Black",
  });
  const rows = [
    r("A", "in_stock", 20, 15, 12, 5, 3),
    r("B", "low", 20, 2, 1, 2, 1),
    r("C", "in_stock", 10, 0, 0, 10, null),
    r("D", "never", 0, 0, 0, 0, null),
  ];
  const all = filterReportRows(rows, DEFAULT_FILTERS);
  expect(all.rows.map((x) => x.name)).toEqual(["A", "B", "C", "D"]);
  // Available counts running low too.
  expect(all.statusCounts).toEqual({ available: 3, low: 1, out: 0, never: 1 });
  expect(all.showCounts).toEqual({ well: 1, slow: 1, not_selling: 1 });

  expect(filterReportRows(rows, { ...DEFAULT_FILTERS, status: "available" }).rows.map((x) => x.name)).toEqual(["A", "B", "C"]);
  const notSellingAvailable = filterReportRows(rows, { ...DEFAULT_FILTERS, status: "available", show: "not_selling" });
  expect(notSellingAvailable.rows.map((x) => x.name)).toEqual(["C"]);
  expect(notSellingAvailable.statusCounts).toEqual({ available: 1, low: 0, out: 0, never: 0 });
  expect(notSellingAvailable.showCounts).toEqual({ well: 1, slow: 1, not_selling: 1 });

  expect(filterReportRows(rows, { ...DEFAULT_FILTERS, q: "sku-b" }).rows.map((x) => x.name)).toEqual(["B"]);
  expect(filterReportRows(rows, { ...DEFAULT_FILTERS, sort: "lastSold", desc: true }).rows.map((x) => x.name)).toEqual(["A", "B", "C", "D"]);
  expect(filterReportRows(rows, { ...DEFAULT_FILTERS, sort: "lastSold", desc: false }).rows.map((x) => x.name)).toEqual(["B", "A", "C", "D"]);
  expect(filterReportRows(rows, { ...DEFAULT_FILTERS, sort: "sold", desc: false }).rows.map((x) => x.name)).toEqual(["C", "D", "B", "A"]);
  expect(filterReportRows(rows, { ...DEFAULT_FILTERS, sort: "left", desc: true }).rows.map((x) => x.name)).toEqual(["C", "A", "B", "D"]);
  // The input isn't reordered.
  expect(rows.map((x) => x.name)).toEqual(["A", "B", "C", "D"]);
});
