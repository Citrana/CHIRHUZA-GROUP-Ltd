import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import type { RequisitionItemResolution } from "./requisitions";

/**
 * Stock batches: what the Chief Inventory Admin buys abroad in one go.
 * draft (fully editable) -> purchased (locked; totals computed;
 * requisition lines resolved) -> approved (approval "stock_batch") ->
 * shipped -> arrived -> received. Before approval, a rejection or an
 * approved "reopen" request returns it to draft. USD only.
 */

export const STOCK_BATCH_STATUSES = [
  "draft",
  "purchased",
  "approved",
  "shipped",
  "arrived",
  "received",
] as const;

export const stockBatchStatusValidator = v.union(
  v.literal("draft"),
  v.literal("purchased"),
  v.literal("approved"),
  v.literal("shipped"),
  v.literal("arrived"),
  v.literal("received"),
);
export type StockBatchStatus = Infer<typeof stockBatchStatusValidator>;

export const batchItemStatusValidator = v.union(
  v.literal("purchased"),
  v.literal("not_purchased"),
);
export type BatchItemStatus = Infer<typeof batchItemStatusValidator>;

export const EXPENSE_CATEGORIES = [
  "transfer_fee",
  "transport",
  "freight",
  "customs",
  "housing",
  "meals",
  "other",
] as const;

export const expenseCategoryValidator = v.union(
  v.literal("transfer_fee"),
  v.literal("transport"),
  v.literal("freight"),
  v.literal("customs"),
  v.literal("housing"),
  v.literal("meals"),
  v.literal("other"),
);

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/**
 * Why an uploaded receipt isn't acceptable, or null if it is: it must be
 * an image or a PDF, at most 10 MB. Browser uploads always carry a content
 * type; a file without one is treated as unknown rather than rejected.
 */
export function receiptProblem(file: {
  contentType?: string;
  size: number;
}): "type" | "size" | null {
  const type = file.contentType;
  if (type !== undefined && !(type.startsWith("image/") || type === "application/pdf")) {
    return "type";
  }
  return file.size > MAX_RECEIPT_BYTES ? "size" : null;
}

/** What's missing on a line before the batch can be marked purchased. */
export type LineProblem = "qty" | "unitCost" | "reason";

type LineLike = {
  status: BatchItemStatus;
  requisitionItemId?: Id<"requisitionItems">;
  qtyRequested: number;
  qtyPurchased: number;
  unitCost?: number;
  reason?: string;
};

/**
 * Rules for a resolved line: purchased needs a whole quantity >= 1 and a
 * unit cost, plus a reason when fewer than requested were bought;
 * not purchased needs a reason.
 */
export function lineProblems(line: LineLike): LineProblem[] {
  const problems: LineProblem[] = [];
  const hasReason = (line.reason ?? "").trim().length > 0;
  if (line.status === "not_purchased") {
    if (!hasReason) problems.push("reason");
    return problems;
  }
  if (!Number.isInteger(line.qtyPurchased) || line.qtyPurchased < 1) problems.push("qty");
  if (line.unitCost === undefined) problems.push("unitCost");
  if (line.requisitionItemId && line.qtyPurchased < line.qtyRequested && !hasReason) {
    problems.push("reason");
  }
  return problems;
}

export type ReceiveProblem = "count" | "over" | "reason";

/** Units neither received nor damaged: missing. */
export function missingQty(line: Pick<Doc<"stockBatchItems">, "qtyPurchased" | "qtyReceived" | "qtyDamaged">): number {
  return line.qtyPurchased - (line.qtyReceived ?? 0) - (line.qtyDamaged ?? 0);
}

/**
 * Rules for a purchased line's receiving count in Goma: it must be counted,
 * received + damaged can't exceed what was purchased, and any damaged or
 * missing unit needs a reason. Not-purchased lines aren't received.
 */
export function receiveProblems(
  line: Pick<Doc<"stockBatchItems">, "status" | "qtyPurchased" | "qtyReceived" | "qtyDamaged" | "receiveReason">,
): ReceiveProblem[] {
  if (line.status !== "purchased") return [];
  if (line.qtyReceived === undefined) return ["count"];
  const missing = missingQty(line);
  if (missing < 0) return ["over"];
  const hasReason = (line.receiveReason ?? "").trim().length > 0;
  return (line.qtyDamaged ?? 0) > 0 || missing > 0 ? (hasReason ? [] : ["reason"]) : [];
}

/** How a requisition line ends up once its batch is purchased. */
export function resolutionFor(line: LineLike): RequisitionItemResolution {
  if (line.status === "not_purchased") return "not_purchased";
  return line.qtyPurchased >= line.qtyRequested ? "purchased" : "partial";
}

/**
 * Keeps a requisition's status in step with its lines: closed when every
 * line is resolved, purchasing while any line sits in a batch, otherwise
 * approved. Only touches requisitions already past approval.
 */
export async function syncRequisitionStatus(
  ctx: MutationCtx,
  requisitionId: Id<"requisitions">,
  actorId: Id<"users">,
): Promise<void> {
  const requisition = await ctx.db.get("requisitions", requisitionId);
  if (!requisition || !["approved", "purchasing", "closed"].includes(requisition.status)) {
    return;
  }
  const lines = await ctx.db
    .query("requisitionItems")
    .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisitionId))
    .take(500);
  let next: "approved" | "purchasing" | "closed";
  if (lines.length > 0 && lines.every((l) => l.resolution !== "pending")) {
    next = "closed";
  } else {
    let inBatch = false;
    for (const line of lines) {
      const batchItem = await ctx.db
        .query("stockBatchItems")
        .withIndex("by_requisitionItemId", (q) => q.eq("requisitionItemId", line._id))
        .first();
      if (batchItem) {
        inBatch = true;
        break;
      }
    }
    next = inBatch ? "purchasing" : "approved";
  }
  if (next === requisition.status) return;
  await ctx.db.patch("requisitions", requisitionId, { status: next });
  await logAudit(ctx, {
    actorId,
    action: "update",
    entityTable: "requisitions",
    entityId: requisitionId,
    businessUnitId: requisition.businessUnitId,
    before: { number: requisition.number, status: requisition.status },
    after: { number: requisition.number, status: next },
  });
}

/** A batch is linked to a requisition exactly while it holds one of its lines. */
export async function syncBatchRequisitionLink(
  ctx: MutationCtx,
  batch: Doc<"stockBatches">,
  requisitionId: Id<"requisitions">,
  actorId: Id<"users">,
): Promise<void> {
  const link = await ctx.db
    .query("stockBatchRequisitions")
    .withIndex("by_batchId_and_requisitionId", (q) =>
      q.eq("batchId", batch._id).eq("requisitionId", requisitionId),
    )
    .unique();
  const items = await ctx.db
    .query("stockBatchItems")
    .withIndex("by_batchId", (q) => q.eq("batchId", batch._id))
    .take(1000);
  let holdsLine = false;
  for (const item of items) {
    if (!item.requisitionItemId) continue;
    const line = await ctx.db.get("requisitionItems", item.requisitionItemId);
    if (line?.requisitionId === requisitionId) {
      holdsLine = true;
      break;
    }
  }
  const requisition = await ctx.db.get("requisitions", requisitionId);
  const describe = { batch: batch.number, requisition: requisition?.number ?? null };
  if (holdsLine && !link) {
    const linkId = await ctx.db.insert("stockBatchRequisitions", { batchId: batch._id, requisitionId });
    await logAudit(ctx, {
      actorId,
      action: "create",
      entityTable: "stockBatchRequisitions",
      entityId: linkId,
      businessUnitId: batch.businessUnitId,
      after: describe,
    });
  } else if (!holdsLine && link) {
    await ctx.db.delete("stockBatchRequisitions", link._id);
    await logAudit(ctx, {
      actorId,
      action: "delete",
      entityTable: "stockBatchRequisitions",
      entityId: link._id,
      businessUnitId: batch.businessUnitId,
      before: describe,
    });
  }
}

export async function batchItems(ctx: MutationCtx, batchId: Id<"stockBatches">) {
  return await ctx.db
    .query("stockBatchItems")
    .withIndex("by_batchId", (q) => q.eq("batchId", batchId))
    .take(1000);
}

export async function linkedRequisitionIds(
  ctx: MutationCtx,
  batchId: Id<"stockBatches">,
): Promise<Id<"requisitions">[]> {
  const links = await ctx.db
    .query("stockBatchRequisitions")
    .withIndex("by_batchId_and_requisitionId", (q) => q.eq("batchId", batchId))
    .take(500);
  return links.map((l) => l.requisitionId);
}

/**
 * Back to draft (after a rejected approval or an approved reopen): clears
 * the goods total and puts the requisition lines back to pending.
 */
async function revertToDraft(
  ctx: MutationCtx,
  batch: Doc<"stockBatches">,
  actorId: Id<"users">,
): Promise<void> {
  for (const item of await batchItems(ctx, batch._id)) {
    if (item.requisitionItemId) {
      await ctx.db.patch("requisitionItems", item.requisitionItemId, { resolution: "pending" });
    }
  }
  await ctx.db.patch("stockBatches", batch._id, {
    status: "draft",
    purchasedAt: undefined,
    purchasedTotal: undefined,
  });
  for (const requisitionId of await linkedRequisitionIds(ctx, batch._id)) {
    await syncRequisitionStatus(ctx, requisitionId, actorId);
  }
  await logAudit(ctx, {
    actorId,
    action: "update",
    entityTable: "stockBatches",
    entityId: batch._id,
    businessUnitId: batch.businessUnitId,
    before: { number: batch.number, status: batch.status },
    after: { number: batch.number, status: "draft" },
  });
}

type ApprovalKind = "approve" | "reopen";

function kindOf(approval: Doc<"approvals">): ApprovalKind {
  const kind = (approval.payload as { kind?: unknown } | null)?.kind;
  if (kind !== "approve" && kind !== "reopen") {
    throw new ConvexError("Unknown stock batch request.");
  }
  return kind;
}

/** The purchased batch an approval decides - refused if it has moved on. */
async function purchasedBatchFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const batchId = ctx.db.normalizeId("stockBatches", approval.entityId);
  const batch = batchId ? await ctx.db.get("stockBatches", batchId) : null;
  if (!batch || batch.status !== "purchased" || batch.approvalId !== approval._id) {
    throw new ConvexError("This batch is no longer waiting for this decision.");
  }
  return batch;
}

/**
 * APPROVAL_HANDLERS.stock_batch. "approve": the purchased batch becomes
 * approved (final; can then be shipped). "reopen": back to draft.
 */
export async function applyStockBatchApproval(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const kind = kindOf(approval);
  const batch = await purchasedBatchFor(ctx, approval);
  if (kind === "reopen") {
    await revertToDraft(ctx, batch, decider._id);
    return;
  }
  await ctx.db.patch("stockBatches", batch._id, { status: "approved", approvedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "stockBatches",
    entityId: batch._id,
    businessUnitId: batch.businessUnitId,
    before: { number: batch.number, status: "purchased" },
    after: { number: batch.number, status: "approved" },
  });
}

/**
 * APPROVAL_REJECTION_HANDLERS.stock_batch (status bookkeeping only): a
 * rejected approval sends the batch back to draft for fixing; a rejected
 * reopen request leaves it purchased.
 */
export async function applyStockBatchRejection(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const kind = kindOf(approval);
  const batch = await purchasedBatchFor(ctx, approval);
  if (kind === "approve") {
    await revertToDraft(ctx, batch, decider._id);
  }
}
