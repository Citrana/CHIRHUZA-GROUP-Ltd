import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";

type ByProduct = FunctionReturnType<typeof api.inventory.overview>["byProduct"];
type Product = ByProduct[number]["product"];

export type UnpricedProduct = Product & { qty: number };

/**
 * What the stock on hand is worth at selling prices: units x each
 * product's suggested price, over the products that have one (cents). The
 * others are listed (sorted by name, with their units) so the page can say
 * which ones aren't counted. Used by the Stock page's card and the stock
 * PDF, so both always agree.
 */
export function stockSellingValue(byProduct: ByProduct): { value: number; unpriced: UnpricedProduct[] } {
  let value = 0;
  const unpriced: UnpricedProduct[] = [];
  for (const p of byProduct) {
    if (p.product.suggestedPrice === null) unpriced.push({ ...p.product, qty: p.qty });
    else value += p.qty * p.product.suggestedPrice;
  }
  unpriced.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || (a.sku ?? "").localeCompare(b.sku ?? ""));
  return { value, unpriced };
}
