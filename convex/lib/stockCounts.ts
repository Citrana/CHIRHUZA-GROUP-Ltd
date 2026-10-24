import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyMovement } from "./inventory";
import { productCategoryValidator } from "./products";
import { SUPER_ADMIN_ROLE_KEY } from "./permissions";

/**
 * Stock counts (stocktakes): someone counts what a holder (the business,
 * a location or a person) really has, blind. Starting a count freezes the
 * expected quantity of each product (`expectedQty`). Sales and transfers
 * made after that are recorded per line (`movedSinceSnapshot`: the
 * holder's stock when the line was counted minus the frozen quantity) so
 * they aren't taken for losses.
 *
 * Each line whose count differs becomes one `stockAdjustments` row with its
 * own approval (type "stock_adjustment"): stock changes only when someone
 * else approves - never the person who counted it - through applyMovement.
 */

export const COUNT_STATUSES = ["counting", "review", "submitted", "done", "cancelled"] as const;
export const countStatusValidator = v.union(
  v.literal("counting"),
  v.literal("review"),
  v.literal("submitted"),
  v.literal("done"),
  v.literal("cancelled"),
);
export type CountStatus = Infer<typeof countStatusValidator>;

export const COUNT_REASONS = ["damaged", "sample", "unrecorded_sale", "miscounted", "transferred", "unknown"] as const;
export const countReasonValidator = v.union(
  v.literal("damaged"),
  v.literal("sample"),
  v.literal("unrecorded_sale"),
  v.literal("miscounted"),
  v.literal("transferred"),
  v.literal("unknown"),
);
export type CountReason = Infer<typeof countReasonValidator>;

/** Which products a count covers: all held, one category, or N picked at random. */
export const countScopeValidator = v.union(
  v.object({ kind: v.literal("all") }),
  v.object({ kind: v.literal("category"), category: productCategoryValidator }),
  v.object({ kind: v.literal("sample"), size: v.number() }),
);
export type CountScope = Infer<typeof countScopeValidator>;

export const adjustmentStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

/** Days without a finished count before Home reminds, when not configured. */
export const DEFAULT_REMINDER_DAYS = 30;
export const MAX_COUNT_ITEMS = 1000;

/** What the system expected when the line was counted. */
export function expectedAtCount(item: Pick<Doc<"stockCountItems">, "expectedQty" | "movedSinceSnapshot">): number {
  return item.expectedQty + item.movedSinceSnapshot;
}

/** Counted minus expected: negative = missing, positive = extra, null = not counted yet. */
export function lineDifference(
  item: Pick<Doc<"stockCountItems">, "expectedQty" | "movedSinceSnapshot" | "countedQty">,
): number | null {
  return item.countedQty === undefined ? null : item.countedQty - expectedAtCount(item);
}

/** Totals of a count's differences, valued at purchase cost (cents). */
export function countTotals(items: Doc<"stockCountItems">[]) {
  let diffCount = 0;
  let lostCost = 0;
  let gainedCost = 0;
  for (const item of items) {
    const diff = lineDifference(item);
    if (!diff) continue;
    diffCount += 1;
    if (diff < 0) lostCost += -diff * item.unitCost;
    else gainedCost += diff * item.unitCost;
  }
  return { diffCount, lostCost, gainedCost };
}

/**
 * The expected quantity and average purchase cost of each product a holder
 * has on hand now. Products with nothing on hand are left out.
 */
export async function snapshotHolder(ctx: QueryCtx, holderId: Id<"holders">) {
  const levels = await ctx.db
    .query("stockLevels")
    .withIndex("by_holderId", (q) => q.eq("holderId", holderId))
    .take(10_000);
  const byProduct = new Map<Id<"products">, { qty: number; cost: number }>();
  for (const level of levels) {
    if (level.qtyOnHand <= 0) continue;
    const lot = await ctx.db.get("inventoryBatches", level.inventoryBatchId);
    if (!lot) continue;
    const entry = byProduct.get(level.productId) ?? { qty: 0, cost: 0 };
    entry.qty += level.qtyOnHand;
    entry.cost += level.qtyOnHand * lot.unitCost;
    byProduct.set(level.productId, entry);
  }
  return [...byProduct].map(([productId, { qty, cost }]) => ({
    productId,
    expectedQty: qty,
    unitCost: Math.round(cost / qty),
  }));
}

/**
 * What a holder has of a product right now. Minus the frozen expected
 * quantity, it is exactly what moved in or out since the count started
 * (sales, distributions, transfers, returns) - no time window to miss.
 */
export async function onHandNow(ctx: QueryCtx, holderId: Id<"holders">, productId: Id<"products">): Promise<number> {
  const levels = await ctx.db
    .query("stockLevels")
    .withIndex("by_productId", (q) => q.eq("productId", productId))
    .take(10_000);
  return levels.filter((l) => l.holderId === holderId).reduce((t, l) => t + l.qtyOnHand, 0);
}

/** Marks a submitted count done once none of its lines waits for a decision. */
async function maybeCompleteCount(ctx: MutationCtx, countId: Id<"stockCounts">, actorId: Id<"users">) {
  const count = await ctx.db.get("stockCounts", countId);
  if (!count || count.status !== "submitted") return;
  const adjustments = await ctx.db
    .query("stockAdjustments")
    .withIndex("by_stockCountId", (q) => q.eq("stockCountId", countId))
    .take(MAX_COUNT_ITEMS);
  if (adjustments.some((a) => a.status === "pending")) return;
  await ctx.db.patch("stockCounts", countId, { status: "done", completedAt: Date.now() });
  await logAudit(ctx, {
    actorId,
    action: "update",
    entityTable: "stockCounts",
    entityId: countId,
    businessUnitId: count.businessUnitId,
    before: { number: count.number, status: "submitted" },
    after: { number: count.number, status: "done" },
  });
}

/** The pending adjustment an approval decides (a stale approval is refused). */
async function pendingAdjustmentFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const adjustment = await ctx.db.get("stockAdjustments", approval.entityId as Id<"stockAdjustments">);
  if (!adjustment || adjustment.approvalId !== approval._id || adjustment.status !== "pending") {
    throw new ConvexError("This stock correction is no longer waiting for this decision.");
  }
  return adjustment;
}

/**
 * APPROVAL_HANDLERS.stock_adjustment: changes the holder's stock by the
 * line's difference through applyMovement ("adjustment"). Missing units
 * leave the holder's oldest lots first; extra units join its newest lot of
 * the product. The person who counted the line can't approve it (the Super
 * Admin can, flagged). If the holder no longer has enough it throws, so
 * nothing changes and the approval stays pending.
 */
export async function applyStockAdjustment(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const adjustment = await pendingAdjustmentFor(ctx, approval);
  const selfCounted = adjustment.countedBy === decider._id;
  const role = decider.roleId ? await ctx.db.get("roles", decider.roleId) : null;
  if (selfCounted && role?.key !== SUPER_ADMIN_ROLE_KEY) {
    throw new ConvexError("You counted this product, so someone else must approve the change.");
  }

  const levels = (
    await ctx.db
      .query("stockLevels")
      .withIndex("by_holderId", (q) => q.eq("holderId", adjustment.holderId))
      .take(10_000)
  ).filter((l) => l.productId === adjustment.productId);
  const lots = new Map<Id<"inventoryBatches">, Doc<"inventoryBatches">>();
  for (const level of levels) {
    const lot = await ctx.db.get("inventoryBatches", level.inventoryBatchId);
    if (lot) lots.set(lot._id, lot);
  }
  const byAge = levels
    .filter((l) => lots.has(l.inventoryBatchId))
    .sort((a, b) => lots.get(a.inventoryBatchId)!.createdAt - lots.get(b.inventoryBatchId)!.createdAt);
  const move = { type: "adjustment" as const, refTable: "stockAdjustments", refId: adjustment._id, actorId: decider._id };

  if (adjustment.qty < 0) {
    let missing = -adjustment.qty;
    const onHand = byAge.reduce((t, l) => t + l.qtyOnHand, 0);
    if (onHand < missing) {
      throw new ConvexError({
        code: "INSUFFICIENT_STOCK" as const,
        message: `Only ${onHand} left in the system for this product here - it can't go below zero.`,
        onHand,
        requested: missing,
      });
    }
    for (const level of byAge) {
      if (missing === 0) break;
      const qty = Math.min(missing, level.qtyOnHand);
      if (qty === 0) continue;
      await applyMovement(ctx, { ...move, inventoryBatchId: level.inventoryBatchId, fromHolderId: adjustment.holderId, qty });
      missing -= qty;
    }
  } else {
    let lotId = byAge.at(-1)?.inventoryBatchId;
    if (!lotId) {
      const newest = await ctx.db
        .query("inventoryBatches")
        .withIndex("by_productId", (q) => q.eq("productId", adjustment.productId))
        .order("desc")
        .first();
      lotId = newest?._id;
    }
    if (!lotId) throw new ConvexError("This product has never been received, so extra units can't be added.");
    await applyMovement(ctx, { ...move, inventoryBatchId: lotId, toHolderId: adjustment.holderId, qty: adjustment.qty });
  }

  await ctx.db.patch("stockAdjustments", adjustment._id, { status: "approved", decidedBy: decider._id, decidedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "stockAdjustments",
    entityId: adjustment._id,
    businessUnitId: adjustment.businessUnitId,
    before: { status: "pending" },
    after: { status: "approved", qty: adjustment.qty, ...(selfCounted ? { selfApproved: true } : {}) },
  });
  await maybeCompleteCount(ctx, adjustment.stockCountId, decider._id);
}

/** APPROVAL_REJECTION_HANDLERS.stock_adjustment (bookkeeping only): stock stays as it was. */
export async function rejectStockAdjustment(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const adjustment = await pendingAdjustmentFor(ctx, approval);
  await ctx.db.patch("stockAdjustments", adjustment._id, { status: "rejected", decidedBy: decider._id, decidedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "stockAdjustments",
    entityId: adjustment._id,
    businessUnitId: adjustment.businessUnitId,
    before: { status: "pending" },
    after: { status: "rejected" },
  });
  await maybeCompleteCount(ctx, adjustment.stockCountId, decider._id);
}
