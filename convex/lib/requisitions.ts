import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";

/**
 * Requisitions: a location's request for stock. Flow:
 * draft -> submitted (approval of type "requisition") -> approved | rejected.
 * Rejected ones can be revised and resubmitted; approved ones are locked
 * (changes need a new requisition). "purchasing" and "closed" belong to the
 * purchasing flow.
 */

export const REQUISITION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "purchasing",
  "closed",
] as const;

export const requisitionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("purchasing"),
  v.literal("closed"),
);
export type RequisitionStatus = Infer<typeof requisitionStatusValidator>;

export const REQUISITION_ITEM_RESOLUTIONS = [
  "pending",
  "purchased",
  "partial",
  "not_purchased",
] as const;

export const requisitionItemResolutionValidator = v.union(
  v.literal("pending"),
  v.literal("purchased"),
  v.literal("partial"),
  v.literal("not_purchased"),
);
export type RequisitionItemResolution = Infer<
  typeof requisitionItemResolutionValidator
>;

/** Only drafts and rejected (being revised) requisitions can be changed. */
export function isEditable(status: RequisitionStatus): boolean {
  return status === "draft" || status === "rejected";
}

/**
 * Next number of a per-business-unit sequence, e.g. `REQ-00007`. The
 * counter is bumped in the caller's transaction, so numbers are unique and
 * never reused.
 */
export async function nextSequenceNumber(
  ctx: MutationCtx,
  businessUnitId: Id<"businessUnits">,
  key: string,
  prefix: string,
): Promise<string> {
  const sequence = await ctx.db
    .query("numberSequences")
    .withIndex("by_businessUnitId_and_key", (q) =>
      q.eq("businessUnitId", businessUnitId).eq("key", key),
    )
    .unique();
  const next = sequence?.next ?? 1;
  if (sequence) {
    await ctx.db.patch("numberSequences", sequence._id, { next: next + 1 });
  } else {
    await ctx.db.insert("numberSequences", { businessUnitId, key, next: 2 });
  }
  return `${prefix}-${String(next).padStart(5, "0")}`;
}

/**
 * The submitted requisition an approval decides - only while it is still
 * that submission (a stale approval from an earlier round is refused).
 */
async function submittedRequisitionFor(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
): Promise<Doc<"requisitions">> {
  const requisitionId = ctx.db.normalizeId("requisitions", approval.entityId);
  const requisition = requisitionId
    ? await ctx.db.get("requisitions", requisitionId)
    : null;
  if (
    !requisition ||
    requisition.status !== "submitted" ||
    requisition.approvalId !== approval._id
  ) {
    throw new ConvexError("This requisition is no longer waiting for this approval.");
  }
  return requisition;
}

async function setDecidedStatus(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
  status: "approved" | "rejected",
) {
  const requisition = await submittedRequisitionFor(ctx, approval);
  await ctx.db.patch("requisitions", requisition._id, { status });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "requisitions",
    entityId: requisition._id,
    businessUnitId: requisition.businessUnitId,
    before: { number: requisition.number, status: "submitted" },
    after: { number: requisition.number, status },
  });
}

/** APPROVAL_HANDLERS.requisition: an approved requisition becomes "approved". */
export async function applyRequisitionApproval(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  await setDecidedStatus(ctx, approval, decider, "approved");
}

/** APPROVAL_REJECTION_HANDLERS.requisition: back to the creator as "rejected". */
export async function applyRequisitionRejection(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  await setDecidedStatus(ctx, approval, decider, "rejected");
}
