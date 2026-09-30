import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./inventory";

/**
 * Distributions: stock sent from the business holder to a location or a
 * person. Submitted as "pending" with an approval (type "distribution");
 * the Chief Admin's approval moves the stock, a rejection moves nothing.
 */

export const DISTRIBUTION_STATUSES = ["pending", "approved", "rejected"] as const;
export const distributionStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
export type DistributionStatus = Infer<typeof distributionStatusValidator>;

export async function distributionItems(
  ctx: MutationCtx,
  distributionId: Id<"distributions">,
): Promise<Doc<"distributionItems">[]> {
  return await ctx.db
    .query("distributionItems")
    .withIndex("by_distributionId", (q) => q.eq("distributionId", distributionId))
    .take(200);
}

/** The pending distribution an approval decides (a stale approval is refused). */
async function pendingDistributionFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const distribution = await ctx.db.get(
    "distributions",
    approval.entityId as Id<"distributions">,
  );
  if (!distribution || distribution.approvalId !== approval._id || distribution.status !== "pending") {
    throw new ConvexError("This distribution is no longer waiting for this decision.");
  }
  return distribution;
}

/**
 * APPROVAL_HANDLERS.distribution: moves every line from the business
 * holder to the destination through applyMovement. If any line would take
 * the business below zero it throws, so nothing moves and the approval
 * stays pending.
 */
export async function applyDistributionApproval(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const distribution = await pendingDistributionFor(ctx, approval);
  const from = await getOrCreateHolder(ctx, distribution.businessUnitId, businessHolderRef(distribution.businessUnitId));
  for (const item of await distributionItems(ctx, distribution._id)) {
    await applyMovement(ctx, {
      type: "distribute",
      inventoryBatchId: item.inventoryBatchId,
      fromHolderId: from,
      toHolderId: distribution.toHolderId,
      qty: item.qty,
      refTable: "distributions",
      refId: distribution._id,
      actorId: decider._id,
    });
  }
  await ctx.db.patch("distributions", distribution._id, { status: "approved", decidedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "distributions",
    entityId: distribution._id,
    businessUnitId: distribution.businessUnitId,
    before: { number: distribution.number, status: "pending" },
    after: { number: distribution.number, status: "approved" },
  });
}

/** APPROVAL_REJECTION_HANDLERS.distribution (bookkeeping only): nothing moves. */
export async function applyDistributionRejection(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const distribution = await pendingDistributionFor(ctx, approval);
  await ctx.db.patch("distributions", distribution._id, { status: "rejected", decidedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "distributions",
    entityId: distribution._id,
    businessUnitId: distribution.businessUnitId,
    before: { number: distribution.number, status: "pending" },
    after: { number: distribution.number, status: "rejected" },
  });
}
