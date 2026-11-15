import { expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { MAX_PARTIAL_RESULTS, cleanCheckItems, compareDay, rankDays, soldOnDay, type ShopDay } from "./salesCheck";

const p = (n: number) => `p${n}` as Id<"products">;
const shop = "shop" as Id<"locations">;
const day = (d: string, sold: Array<[number, number]>): ShopDay => ({
  locationId: shop,
  day: d,
  sold: new Map(sold.map(([n, units]) => [p(n), units])),
});

test("soldOnDay keeps products with net units above 0", () => {
  const sold = soldOnDay([
    { productId: p(1), unitsSold: 2 },
    { productId: p(2), unitsSold: 0 },
    { productId: p(3), unitsSold: -1 },
  ]);
  expect([...sold.entries()]).toEqual([[p(1), 2]]);
});

test("full matches: fewest extra products first, then most recent", () => {
  const items = [{ productId: p(1) }, { productId: p(2) }];
  const ranked = rankDays(items, [
    day("2026-11-01", [[1, 1], [2, 1], [3, 1]]),
    day("2026-11-02", [[1, 1], [2, 1]]),
    day("2026-11-03", [[1, 1], [2, 4], [3, 1]]),
    day("2026-11-04", [[1, 1]]),
  ]);
  expect(ranked.kind).toBe("full");
  expect(ranked.results.map((r) => r.day)).toEqual(["2026-11-02", "2026-11-03", "2026-11-01"]);
  expect(ranked.total).toBe(3);
  expect(ranked.results[1].extras).toEqual([{ productId: p(3), units: 1 }]);
});

test("quantities never exclude a day; differences are shown", () => {
  const match = compareDay([{ productId: p(1), qty: 3 }, { productId: p(2) }], day("2026-11-01", [[1, 1], [2, 5]]));
  expect(match.missing).toEqual([]);
  expect(match.found).toEqual([
    { productId: p(1), units: 1, qtyDiff: -2 },
    { productId: p(2), units: 5, qtyDiff: null },
  ]);
});

test("no full match: best partial matches with the missing products", () => {
  const items = [1, 2, 3, 4, 5].map((n) => ({ productId: p(n) }));
  const ranked = rankDays(items, [
    day("2026-11-01", [[1, 1], [2, 1]]),
    day("2026-11-02", [[1, 1], [2, 1], [3, 1], [4, 1], [9, 1]]),
    day("2026-11-03", [[1, 1], [2, 1], [3, 1], [5, 1]]),
    day("2026-11-04", [[1, 1], [2, 1], [3, 1], [4, 1]]),
    day("2026-11-05", [[8, 1]]),
  ]);
  expect(ranked.kind).toBe("partial");
  expect(ranked.results.map((r) => [r.day, r.matched])).toEqual([
    ["2026-11-04", 4],
    ["2026-11-03", 4],
    ["2026-11-02", 4],
    ["2026-11-01", 2],
  ]);
  expect(ranked.results[0].missing).toEqual([p(5)]);
  expect(ranked.results[1].missing).toEqual([p(4)]);
  expect(ranked.results[2].extras).toEqual([{ productId: p(9), units: 1 }]);
});

test("partials are capped; nothing in common gives none", () => {
  const days = Array.from({ length: 15 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, [[1, 1]]));
  const ranked = rankDays([{ productId: p(1) }, { productId: p(2) }], days);
  expect(ranked.results).toHaveLength(MAX_PARTIAL_RESULTS);
  expect(ranked.total).toBe(15);
  expect(rankDays([{ productId: p(7) }], days)).toEqual({ kind: "none", results: [], total: 0 });
  expect(rankDays([], days).kind).toBe("none");
});

test("cleanCheckItems: whole quantities from 1, each product once", () => {
  expect(cleanCheckItems([{ productId: p(1), qty: 2 }, { productId: p(1) }, { productId: p(2) }])).toEqual([
    { productId: p(1), qty: 2 },
    { productId: p(2) },
  ]);
  expect(cleanCheckItems([{ productId: p(1), qty: 0 }])).toBeNull();
  expect(cleanCheckItems([{ productId: p(1), qty: 1.5 }])).toBeNull();
});
