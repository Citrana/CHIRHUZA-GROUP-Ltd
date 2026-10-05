import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import {
  findHolder,
  groupStock,
  holderName,
  rebuildProductStock as rebuildProductStockFor,
  type StockRow,
} from "./lib/inventory";
import { PRODUCT_PROFILES, productDetails } from "./lib/products";

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

// ------------------------------------------------------ product stock report

const reportStatusValidator = v.union(
  v.literal("in_stock"),
  v.literal("low"),
  v.literal("out"),
  v.literal("never"),
);
type ReportStatus = "in_stock" | "low" | "out" | "never";

const MAX_REPORT_ROWS = 5000;

/** One product's line in the stock report (summary row or "never stocked"). */
async function reportRow(
  ctx: AuthedQueryCtx,
  product: Doc<"products">,
  summary: Doc<"productStock"> | null,
  withPhotos: boolean,
) {
  const details = await productDetails(ctx, product);
  return {
    productId: product._id,
    name: product.name,
    sku: product.sku,
    productStatus: product.status,
    ...details,
    photoUrl: withPhotos && product.photoFileId ? await ctx.storage.getUrl(product.photoFileId) : null,
    lowStockThreshold: product.lowStockThreshold ?? null,
    status: (summary?.status ?? "never") as ReportStatus,
    onHand: summary?.onHand ?? 0,
    received: summary?.received ?? 0,
    sold: summary?.sold ?? 0,
    lastReceivedAt: summary?.lastReceivedAt ?? null,
    lastSoldAt: summary?.lastSoldAt ?? null,
    outOfStockSince: summary?.outOfStockSince ?? null,
  };
}

/** Archived products only show while they still have stock. */
function shown(product: Doc<"products">, summary: Doc<"productStock"> | null) {
  return product.status !== "archived" || (summary?.onHand ?? 0) > 0;
}

const summaryOf = (ctx: AuthedQueryCtx, productId: Id<"products">) =>
  ctx.db.query("productStock").withIndex("by_productId", (q) => q.eq("productId", productId)).unique();

/**
 * The stock report: every product of the service (finished and never
 * stocked ones too) with received, sold, on hand, last dates and a status
 * (in stock / low / out / never). Filter by status; search by name, SKU,
 * length, size or colour. stock.view, all locations.
 */
export const productReport = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    status: v.optional(reportStatusValidator),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const withPhotos = PRODUCT_PROFILES[unit.key].attributes.photo;
    const term = args.search?.trim().toLowerCase();

    if (args.status && args.status !== "never" && !term) {
      // A status with a summary row: page through the summaries.
      const status = args.status;
      const result = await ctx.db
        .query("productStock")
        .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
        .paginate(args.paginationOpts);
      const page = [];
      for (const summary of result.page) {
        const product = await ctx.db.get("products", summary.productId);
        if (product && shown(product, summary)) page.push(await reportRow(ctx, product, summary, withPhotos));
      }
      return { ...result, page };
    }

    // Otherwise page through the products (by name, or the search index).
    const result = term
      ? await ctx.db
          .query("products")
          .withSearchIndex("search_text", (q) => q.search("searchText", term).eq("businessUnitId", unit._id))
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("products")
          .withIndex("by_businessUnitId_and_name", (q) => q.eq("businessUnitId", unit._id))
          .paginate(args.paginationOpts);
    const page = [];
    for (const product of result.page) {
      const summary = await summaryOf(ctx, product._id);
      if (!shown(product, summary)) continue;
      const status: ReportStatus = summary?.status ?? "never";
      if (args.status && status !== args.status) continue;
      page.push(await reportRow(ctx, product, summary, withPhotos));
    }
    return { ...result, page };
  },
});

/** How many products are in stock / low / out / never stocked (filter chips). */
export const statusCounts = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const counts: Record<ReportStatus, number> = { in_stock: 0, low: 0, out: 0, never: 0 };
    const stocked = new Set<string>();
    for (const status of ["in_stock", "low", "out"] as const) {
      const rows = await ctx.db
        .query("productStock")
        .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
        .take(MAX_REPORT_ROWS);
      for (const row of rows) stocked.add(row.productId);
      counts[status] = rows.length;
    }
    const products = await ctx.db
      .query("products")
      .withIndex("by_businessUnitId_and_name", (q) => q.eq("businessUnitId", unit._id))
      .take(MAX_REPORT_ROWS);
    counts.never = products.filter((p) => p.status !== "archived" && !stocked.has(p._id)).length;
    return counts;
  },
});

/** Every report line (bounded), for the CSV download. */
export const productReportExport = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator, status: v.optional(reportStatusValidator) },
  handler: async (ctx, { businessUnitKey, status }) => {
    await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const products = await ctx.db
      .query("products")
      .withIndex("by_businessUnitId_and_name", (q) => q.eq("businessUnitId", unit._id))
      .take(MAX_REPORT_ROWS);
    const rows = [];
    for (const product of products) {
      const summary = await summaryOf(ctx, product._id);
      if (!shown(product, summary)) continue;
      if (status && (summary?.status ?? "never") !== status) continue;
      rows.push(await reportRow(ctx, product, summary, false));
    }
    return rows;
  },
});

/**
 * One product: where its stock is now (per holder) and its movement
 * history, newest first, with references (batch / distribution / sale
 * number) and the running total held.
 */
export const productStockDetail = authedQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    await ctx.requirePermission("stock.view");
    const product = await ctx.db.get("products", productId);
    if (!product) return null;

    const levels = await ctx.db
      .query("stockLevels")
      .withIndex("by_productId", (q) => q.eq("productId", productId))
      .take(2000);
    const byHolder = new Map<string, { holderId: Id<"holders">; type: string; name: string; qty: number }>();
    const holderNames = new Map<string, { type: string; name: string }>();
    const holderInfo = async (id: Id<"holders">) => {
      if (!holderNames.has(id)) {
        const holder = await ctx.db.get("holders", id);
        holderNames.set(id, holder ? { type: holder.type, name: await holderName(ctx, holder) } : { type: "business", name: "—" });
      }
      return holderNames.get(id)!;
    };
    for (const level of levels) {
      if (level.qtyOnHand <= 0) continue;
      const info = await holderInfo(level.holderId);
      const row = byHolder.get(level.holderId) ?? { holderId: level.holderId, ...info, qty: 0 };
      row.qty += level.qtyOnHand;
      byHolder.set(level.holderId, row);
    }

    const lots = await ctx.db
      .query("inventoryBatches")
      .withIndex("by_productId", (q) => q.eq("productId", productId))
      .take(500);
    const movements: Doc<"inventoryMovements">[] = [];
    for (const lot of lots) {
      movements.push(
        ...(await ctx.db
          .query("inventoryMovements")
          .withIndex("by_inventoryBatchId", (q) => q.eq("inventoryBatchId", lot._id))
          .take(2000)),
      );
    }
    movements.sort((a, b) => a.timestamp - b.timestamp || a._creationTime - b._creationTime);
    let balance = 0;
    const references = new Map<string, string | null>();
    const referenceOf = async (table: string, id: string) => {
      const key = `${table}:${id}`;
      if (!references.has(key)) {
        let number: string | null = null;
        if (table === "stockBatches" || table === "distributions" || table === "sales") {
          const normalized = ctx.db.normalizeId(table, id);
          const doc = normalized ? await ctx.db.get(normalized) : null;
          number = doc && "number" in doc ? (doc.number as string) : null;
        }
        references.set(key, number);
      }
      return references.get(key)!;
    };
    const history = [];
    for (const m of movements) {
      balance += (m.toHolderId ? m.qty : 0) - (m.fromHolderId ? m.qty : 0);
      history.push({ m, balance });
    }
    const recent = history.slice(-200).reverse();
    return {
      holders: [...byHolder.values()].sort((a, b) => b.qty - a.qty),
      history: await Promise.all(
        recent.map(async ({ m, balance }) => ({
          _id: m._id,
          type: m.type,
          qty: m.qty,
          at: m.timestamp,
          from: m.fromHolderId ? await holderInfo(m.fromHolderId) : null,
          to: m.toHolderId ? await holderInfo(m.toHolderId) : null,
          reference: await referenceOf(m.refTable, m.refId),
          balance,
        })),
      ),
    };
  },
});

/**
 * Backfill / repair: rebuilds a unit's product stock summaries.
 *   npx convex run inventory:rebuildProductStock '{"businessUnitKey":"hair"}'
 */
export const rebuildProductStock = internalMutation({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    return await rebuildProductStockFor(ctx, unit._id);
  },
});
