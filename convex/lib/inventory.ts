import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";

/**
 * The inventory core (CLAUDE.md "Inventory"). Sellable lots
 * (`inventoryBatches`) are created only by receiving a purchase batch.
 * Where they are is `stockLevels` (lot x holder -> qtyOnHand); how they
 * got there is `inventoryMovements` (append-only).
 *
 * Every quantity change goes through `applyMovement` below - the ONLY code
 * that writes `stockLevels` or `inventoryMovements` (a test scans the
 * source for that). It refuses to take a holder below zero.
 */

export const HOLDER_TYPES = ["business", "location", "user"] as const;
export const holderTypeValidator = v.union(
  v.literal("business"),
  v.literal("location"),
  v.literal("user"),
);
export type HolderType = Infer<typeof holderTypeValidator>;

/** What a holder refers to, by type: the business unit itself, a location or a person. */
export const holderRefValidator = v.union(
  v.id("businessUnits"),
  v.id("locations"),
  v.id("users"),
);

export const MOVEMENT_TYPES = [
  "receive",
  "distribute",
  "sale",
  "adjustment",
  "transfer",
  "return",
] as const;
export const movementTypeValidator = v.union(
  v.literal("receive"),
  v.literal("distribute"),
  v.literal("sale"),
  v.literal("adjustment"),
  v.literal("transfer"),
  v.literal("return"),
);
export type MovementType = Infer<typeof movementTypeValidator>;

// ------------------------------------------------- per-product summary

export const productStockStatusValidator = v.union(v.literal("in_stock"), v.literal("low"), v.literal("out"));
export type ProductStockStatus = Infer<typeof productStockStatusValidator>;

/** A product's stock summary (the productStock row without ids/status). */
export type ProductStockState = {
  received: number;
  sold: number;
  onHand: number;
  lastReceivedAt?: number;
  lastSoldAt?: number;
  outOfStockSince?: number;
};

/** Out at 0; low at or below the product's threshold; otherwise in stock. */
export function stockStatus(onHand: number, threshold: number | undefined): ProductStockStatus {
  if (onHand <= 0) return "out";
  if (threshold !== undefined && onHand <= threshold) return "low";
  return "in_stock";
}

/**
 * How one movement changes a product's summary (pure): on hand goes up for
 * a destination and down for a source (a distribution nets to 0);
 * receipts and sales add to their totals; reaching 0 starts "out of stock
 * since", rising above 0 clears it.
 */
export function nextProductStock(
  prev: ProductStockState | null,
  movement: { type: MovementType; qty: number; hasFrom: boolean; hasTo: boolean },
  at: number,
): ProductStockState {
  const base: ProductStockState = prev ?? { received: 0, sold: 0, onHand: 0 };
  const onHand = base.onHand + (movement.hasTo ? movement.qty : 0) - (movement.hasFrom ? movement.qty : 0);
  const next: ProductStockState = {
    ...base,
    onHand,
    received: base.received + (movement.type === "receive" ? movement.qty : 0),
    sold: base.sold + (movement.type === "sale" ? movement.qty : 0),
  };
  if (movement.type === "receive") next.lastReceivedAt = at;
  if (movement.type === "sale") next.lastSoldAt = at;
  if (onHand <= 0) {
    next.outOfStockSince = base.onHand > 0 || base.outOfStockSince === undefined ? at : base.outOfStockSince;
  } else {
    delete next.outOfStockSince;
  }
  return next;
}

function stateOf(row: Doc<"productStock">): ProductStockState {
  const { received, sold, onHand, lastReceivedAt, lastSoldAt, outOfStockSince } = row;
  return {
    received,
    sold,
    onHand,
    ...(lastReceivedAt !== undefined ? { lastReceivedAt } : {}),
    ...(lastSoldAt !== undefined ? { lastSoldAt } : {}),
    ...(outOfStockSince !== undefined ? { outOfStockSince } : {}),
  };
}

/** Writes a product's summary (insert or full replace), with its status. */
async function writeProductStock(
  ctx: MutationCtx,
  businessUnitId: Id<"businessUnits">,
  productId: Id<"products">,
  state: ProductStockState,
  existing: Doc<"productStock"> | null,
) {
  const product = await ctx.db.get("products", productId);
  const row = { businessUnitId, productId, ...state, status: stockStatus(state.onHand, product?.lowStockThreshold) };
  if (existing) await ctx.db.replace("productStock", existing._id, row);
  else await ctx.db.insert("productStock", row);
}

async function productStockOf(ctx: QueryCtx, productId: Id<"products">) {
  return await ctx.db.query("productStock").withIndex("by_productId", (q) => q.eq("productId", productId)).unique();
}

/** Recomputes a product's status after its low-stock threshold changed. */
export async function refreshProductStockStatus(ctx: MutationCtx, productId: Id<"products">) {
  const row = await productStockOf(ctx, productId);
  if (row) await writeProductStock(ctx, row.businessUnitId, productId, stateOf(row), row);
}

/**
 * Rebuilds a unit's product summaries from its movements (backfill /
 * repair), replaying them in time order so dates and "out of stock since"
 * come out as they happened.
 */
export async function rebuildProductStock(ctx: MutationCtx, businessUnitId: Id<"businessUnits">) {
  for (const status of ["in_stock", "low", "out"] as const) {
    const rows = await ctx.db
      .query("productStock")
      .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", businessUnitId).eq("status", status))
      .take(10_000);
    for (const row of rows) await ctx.db.delete("productStock", row._id);
  }
  const lots = await ctx.db
    .query("inventoryBatches")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", businessUnitId))
    .take(10_000);
  const events: { productId: Id<"products">; movement: Doc<"inventoryMovements"> }[] = [];
  for (const lot of lots) {
    const movements = await ctx.db
      .query("inventoryMovements")
      .withIndex("by_inventoryBatchId", (q) => q.eq("inventoryBatchId", lot._id))
      .take(10_000);
    for (const movement of movements) events.push({ productId: lot.productId, movement });
  }
  events.sort((a, b) => a.movement.timestamp - b.movement.timestamp || a.movement._creationTime - b.movement._creationTime);
  const states = new Map<Id<"products">, ProductStockState>();
  for (const { productId, movement } of events) {
    states.set(
      productId,
      nextProductStock(
        states.get(productId) ?? null,
        { type: movement.type, qty: movement.qty, hasFrom: !!movement.fromHolderId, hasTo: !!movement.toHolderId },
        movement.timestamp,
      ),
    );
  }
  for (const [productId, state] of states) await writeProductStock(ctx, businessUnitId, productId, state, null);
  return { products: states.size };
}

type HolderRef =
  | { type: "business"; refId: Id<"businessUnits"> }
  | { type: "location"; refId: Id<"locations"> }
  | { type: "user"; refId: Id<"users"> };

export async function findHolder(
  ctx: QueryCtx,
  businessUnitId: Id<"businessUnits">,
  ref: HolderRef,
): Promise<Doc<"holders"> | null> {
  return await ctx.db
    .query("holders")
    .withIndex("by_businessUnitId_and_type_and_refId", (q) =>
      q.eq("businessUnitId", businessUnitId).eq("type", ref.type).eq("refId", ref.refId),
    )
    .unique();
}

/** The holder for a business unit / location / person, created on first use. */
export async function getOrCreateHolder(
  ctx: MutationCtx,
  businessUnitId: Id<"businessUnits">,
  ref: HolderRef,
): Promise<Id<"holders">> {
  const existing = await findHolder(ctx, businessUnitId, ref);
  if (existing) return existing._id;
  return await ctx.db.insert("holders", { businessUnitId, type: ref.type, refId: ref.refId });
}

/** The business unit's own holder: where received stock lands. */
export function businessHolderRef(businessUnitId: Id<"businessUnits">): HolderRef {
  return { type: "business", refId: businessUnitId };
}

/** A holder's display name: "business" (the UI translates it), a location or a person. */
export async function holderName(ctx: QueryCtx, holder: Doc<"holders">): Promise<string> {
  if (holder.type === "business") return "business";
  const id = holder.refId;
  const ref =
    holder.type === "location"
      ? await ctx.db.get("locations", id as Id<"locations">)
      : await ctx.db.get("users", id as Id<"users">);
  return ref?.name ?? "—";
}

export async function stockLevelOf(
  ctx: QueryCtx,
  inventoryBatchId: Id<"inventoryBatches">,
  holderId: Id<"holders">,
): Promise<Doc<"stockLevels"> | null> {
  return await ctx.db
    .query("stockLevels")
    .withIndex("by_inventoryBatchId_and_holderId", (q) =>
      q.eq("inventoryBatchId", inventoryBatchId).eq("holderId", holderId),
    )
    .unique();
}

export type Movement = {
  type: MovementType;
  inventoryBatchId: Id<"inventoryBatches">;
  /** Missing for stock entering the system (receive). */
  fromHolderId?: Id<"holders">;
  /** Missing for stock leaving it (e.g. a sale). */
  toHolderId?: Id<"holders">;
  qty: number;
  /** The business record behind the movement (e.g. "distributions", its id). */
  refTable: string;
  refId: string;
  actorId: Id<"users">;
};

/**
 * THE one way stock quantities change. In the caller's mutation (so
 * atomically with it): checks the quantity, takes it from `fromHolderId`
 * - refusing to go below zero - adds it to `toHolderId`, appends the
 * movement and audits it. Convex transactions are serializable, so two
 * concurrent withdrawals can't both pass the check.
 */
export async function applyMovement(ctx: MutationCtx, movement: Movement): Promise<Id<"inventoryMovements">> {
  const { qty, inventoryBatchId, fromHolderId, toHolderId } = movement;
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new ConvexError("Quantity must be a whole number greater than 0.");
  }
  if (!fromHolderId && !toHolderId) {
    throw new ConvexError("A movement needs a source or a destination.");
  }
  if (fromHolderId && fromHolderId === toHolderId) {
    throw new ConvexError("Source and destination must differ.");
  }
  const lot = await ctx.db.get("inventoryBatches", inventoryBatchId);
  if (!lot) throw new ConvexError("Stock lot not found.");

  const levels: Record<string, { before: number; after: number }> = {};
  if (fromHolderId) {
    const level = await stockLevelOf(ctx, inventoryBatchId, fromHolderId);
    const onHand = level?.qtyOnHand ?? 0;
    if (!level || onHand < qty) {
      throw new ConvexError({
        code: "INSUFFICIENT_STOCK" as const,
        message: `Not enough stock: ${onHand} on hand, ${qty} requested.`,
        onHand,
        requested: qty,
      });
    }
    await ctx.db.patch("stockLevels", level._id, { qtyOnHand: onHand - qty });
    levels.from = { before: onHand, after: onHand - qty };
  }
  if (toHolderId) {
    const level = await stockLevelOf(ctx, inventoryBatchId, toHolderId);
    const onHand = level?.qtyOnHand ?? 0;
    if (level) {
      await ctx.db.patch("stockLevels", level._id, { qtyOnHand: onHand + qty });
    } else {
      await ctx.db.insert("stockLevels", {
        businessUnitId: lot.businessUnitId,
        inventoryBatchId,
        productId: lot.productId,
        holderId: toHolderId,
        qtyOnHand: qty,
      });
    }
    levels.to = { before: onHand, after: onHand + qty };
  }

  const timestamp = Date.now();
  const movementId = await ctx.db.insert("inventoryMovements", {
    businessUnitId: lot.businessUnitId,
    type: movement.type,
    inventoryBatchId,
    ...(fromHolderId ? { fromHolderId } : {}),
    ...(toHolderId ? { toHolderId } : {}),
    qty,
    refTable: movement.refTable,
    refId: movement.refId,
    actorId: movement.actorId,
    timestamp,
  });

  // The product's stock summary (report), in the same transaction.
  const summary = await productStockOf(ctx, lot.productId);
  await writeProductStock(
    ctx,
    lot.businessUnitId,
    lot.productId,
    nextProductStock(summary ? stateOf(summary) : null, { type: movement.type, qty, hasFrom: !!fromHolderId, hasTo: !!toHolderId }, timestamp),
    summary,
  );

  const product = await ctx.db.get("products", lot.productId);
  const nameOf = async (id?: Id<"holders">) => {
    const holder = id ? await ctx.db.get("holders", id) : null;
    return holder ? await holderName(ctx, holder) : null;
  };
  await logAudit(ctx, {
    actorId: movement.actorId,
    action: "create",
    entityTable: "inventoryMovements",
    entityId: movementId,
    businessUnitId: lot.businessUnitId,
    after: {
      type: movement.type,
      product: product?.name ?? null,
      sku: product?.sku ?? null,
      lot: inventoryBatchId,
      from: await nameOf(fromHolderId),
      to: await nameOf(toHolderId),
      qty,
      fromOnHand: levels.from ? `${levels.from.before} → ${levels.from.after}` : null,
      toOnHand: levels.to ? `${levels.to.before} → ${levels.to.after}` : null,
      ref: `${movement.refTable}:${movement.refId}`,
    },
  });
  return movementId;
}

/** One holder's quantity of one lot, with what the overview shows about it. */
export type StockRow = {
  qty: number;
  holder: { id: Id<"holders">; type: HolderType; name: string };
  lot: {
    id: Id<"inventoryBatches">;
    batchNumber: string | null;
    unitCost: number;
    receivedQty: number;
    createdAt: number;
  };
  product: {
    id: Id<"products">;
    name: string | null;
    sku: string | null;
    lengthInches: number | null;
    sizeName: string | null;
    colourName: string | null;
  };
};

/**
 * The stock overview's three views of the same rows: by product, by lot
 * and by holder, each with its breakdown. Values are cents (qty x the
 * lot's purchase unit cost). Rows with nothing on hand are ignored.
 */
export function groupStock(rows: StockRow[]) {
  const held = rows.filter((r) => r.qty > 0);
  const value = (r: StockRow) => r.qty * r.lot.unitCost;

  const byProduct = new Map<string, { product: StockRow["product"]; qty: number; value: number; holders: Map<string, { holder: StockRow["holder"]; qty: number }> }>();
  const byLot = new Map<string, { lot: StockRow["lot"]; product: StockRow["product"]; qty: number; value: number; holders: { holder: StockRow["holder"]; qty: number }[] }>();
  const byHolder = new Map<string, { holder: StockRow["holder"]; qty: number; value: number; lines: { product: StockRow["product"]; lot: StockRow["lot"]; qty: number }[] }>();

  for (const row of held) {
    const p = byProduct.get(row.product.id) ?? { product: row.product, qty: 0, value: 0, holders: new Map() };
    p.qty += row.qty;
    p.value += value(row);
    const ph = p.holders.get(row.holder.id) ?? { holder: row.holder, qty: 0 };
    ph.qty += row.qty;
    p.holders.set(row.holder.id, ph);
    byProduct.set(row.product.id, p);

    const l = byLot.get(row.lot.id) ?? { lot: row.lot, product: row.product, qty: 0, value: 0, holders: [] };
    l.qty += row.qty;
    l.value += value(row);
    l.holders.push({ holder: row.holder, qty: row.qty });
    byLot.set(row.lot.id, l);

    const h = byHolder.get(row.holder.id) ?? { holder: row.holder, qty: 0, value: 0, lines: [] };
    h.qty += row.qty;
    h.value += value(row);
    h.lines.push({ product: row.product, lot: row.lot, qty: row.qty });
    byHolder.set(row.holder.id, h);
  }

  const byName = (a: { name: string | null }, b: { name: string | null }) => (a.name ?? "").localeCompare(b.name ?? "");
  const holderOrder = (a: StockRow["holder"], b: StockRow["holder"]) =>
    HOLDER_TYPES.indexOf(a.type) - HOLDER_TYPES.indexOf(b.type) || a.name.localeCompare(b.name);
  return {
    byProduct: [...byProduct.values()]
      .map((p) => ({ ...p, holders: [...p.holders.values()].sort((a, b) => holderOrder(a.holder, b.holder)) }))
      .sort((a, b) => byName(a.product, b.product)),
    byLot: [...byLot.values()]
      .map((l) => ({ ...l, holders: l.holders.sort((a, b) => holderOrder(a.holder, b.holder)) }))
      .sort((a, b) => byName(a.product, b.product) || a.lot.createdAt - b.lot.createdAt),
    byHolder: [...byHolder.values()]
      .map((h) => ({ ...h, lines: h.lines.sort((a, b) => byName(a.product, b.product)) }))
      .sort((a, b) => holderOrder(a.holder, b.holder)),
  };
}
