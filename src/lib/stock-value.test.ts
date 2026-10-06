import { expect, test } from "vitest";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { stockSellingValue } from "./stock-value";

type ByProduct = FunctionReturnType<typeof api.inventory.overview>["byProduct"];

const row = (name: string, sku: string, qty: number, suggestedPrice: number | null) => ({
  product: { id: sku, name, sku, lengthInches: null, sizeName: null, colourName: null, suggestedPrice },
  qty,
  value: 0,
  holders: [],
});

test("value at selling prices, and the products left out (sorted, with their units)", () => {
  // Bob's 6 units may come from several lots: byProduct already merges them.
  const byProduct = [
    row("Wig Cap", "HAIR-00018", 20, null),
    row("Bob", "HAIR-00002", 6, 7000),
    row("Edge Control", "HAIR-00017", 15, null),
    row("Argan Oil Serum", "HAIR-00016", 10, 900),
  ] as unknown as ByProduct;
  const { value, unpriced } = stockSellingValue(byProduct);
  expect(value).toBe(6 * 7000 + 10 * 900);
  expect(unpriced.map((p) => [p.name, p.sku, p.qty])).toEqual([
    ["Edge Control", "HAIR-00017", 15],
    ["Wig Cap", "HAIR-00018", 20],
  ]);
});

test("all priced: nothing left out; none priced: value 0, all listed", () => {
  expect(stockSellingValue([row("Bob", "B", 2, 500)] as unknown as ByProduct)).toEqual({ value: 1000, unpriced: [] });
  const none = stockSellingValue([row("A", "A1", 1, null), row("B", "B1", 3, null)] as unknown as ByProduct);
  expect(none.value).toBe(0);
  expect(none.unpriced.map((p) => p.name)).toEqual(["A", "B"]);
  expect(stockSellingValue([] as unknown as ByProduct)).toEqual({ value: 0, unpriced: [] });
});
