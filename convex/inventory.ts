import type { Doc, Id } from "./_generated/dataModel";
import { authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { findHolder, groupStock, holderName, type StockRow } from "./lib/inventory";
import { productDetails } from "./lib/products";

/**
 * Stock overview (stock.view): what's on hand, by product, by lot and by
 * holder. A viewer whose stock.view scope is own_location sees only their
 * location's stock and their own.
 */

const MAX_LEVELS = 5000;

/** Enriches stock levels into overview rows (names looked up once each). */
export async function stockRows(ctx: AuthedQueryCtx, levels: Doc<"stockLevels">[]): Promise<StockRow[]> {
  const holders = new Map<string, StockRow["holder"]>();
  const lots = new Map<string, StockRow["lot"]>();
  const products = new Map<string, StockRow["product"]>();
  const rows: StockRow[] = [];
  for (const level of levels) {
    if (!holders.has(level.holderId)) {
      const holder = await ctx.db.get("holders", level.holderId);
      if (!holder) continue;
      holders.set(level.holderId, { id: holder._id, type: holder.type, name: await holderName(ctx, holder) });
    }
    if (!lots.has(level.inventoryBatchId)) {
      const lot = await ctx.db.get("inventoryBatches", level.inventoryBatchId);
      if (!lot) continue;
      const batch = await ctx.db.get("stockBatches", lot.stockBatchId);
      lots.set(level.inventoryBatchId, {
        id: lot._id,
        batchNumber: batch?.number ?? null,
        unitCost: lot.unitCost,
        receivedQty: lot.receivedQty,
        createdAt: lot.createdAt,
      });
    }
    if (!products.has(level.productId)) {
      const product = await ctx.db.get("products", level.productId);
      const details = await productDetails(ctx, product);
      products.set(level.productId, {
        id: level.productId,
        name: product?.name ?? null,
        sku: product?.sku ?? null,
        lengthInches: product?.lengthInches ?? null,
        colourName: details.colourName,
        sizeName: details.sizeName,
      });
    }
    rows.push({
      qty: level.qtyOnHand,
      holder: holders.get(level.holderId)!,
      lot: lots.get(level.inventoryBatchId)!,
      product: products.get(level.productId)!,
    });
  }
  return rows;
}

/** The holders an own_location viewer may see: their location and themselves. */
async function ownHolders(ctx: AuthedQueryCtx, businessUnitId: Id<"businessUnits">) {
  const ids: Id<"holders">[] = [];
  if (ctx.user.locationId) {
    const location = await findHolder(ctx, businessUnitId, { type: "location", refId: ctx.user.locationId });
    if (location) ids.push(location._id);
  }
  const self = await findHolder(ctx, businessUnitId, { type: "user", refId: ctx.user._id });
  if (self) ids.push(self._id);
  return ids;
}

export const overview = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    let levels: Doc<"stockLevels">[];
    if (scope === "own_location") {
      levels = [];
      for (const holderId of await ownHolders(ctx, unit._id)) {
        levels.push(
          ...(await ctx.db
            .query("stockLevels")
            .withIndex("by_holderId", (q) => q.eq("holderId", holderId))
            .take(MAX_LEVELS)),
        );
      }
    } else {
      levels = await ctx.db
        .query("stockLevels")
        .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
        .take(MAX_LEVELS);
    }
    return { scope, ...groupStock(await stockRows(ctx, levels.filter((l) => l.qtyOnHand > 0))) };
  },
});
