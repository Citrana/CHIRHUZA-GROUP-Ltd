import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyRollupEvent, openingCashEvent } from "./analytics";

/**
 * Opening cash (CLAUDE.md "Cash"): money the owner holds that can't be
 * traced to a sale. A "record" adds to Cash on hand (dailyFinance
 * `openingCash`, via openingCashEvent); it never counts in sales, margin or
 * net profit. Rows are never edited or deleted: a mistake is undone by a
 * "reversal" row pointing at the record (reversesId). A row above the unit's
 * threshold (cashSettings) is created `pending` and decided through the
 * approval engine (type "opening_cash", cash.opening.approve); the rest are
 * created `approved`. Only this file patches a row's status. USD cents.
 */

export const openingCashKindValidator = v.union(v.literal("record"), v.literal("reversal"));
export type OpeningCashKind = Infer<typeof openingCashKindValidator>;

export const openingCashStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
export type OpeningCashStatus = Infer<typeof openingCashStatusValidator>;
export const OPENING_CASH_STATUSES = ["pending", "approved", "rejected"] as const;

/** The unit's approval threshold in cents (no settings row = 0: everything is approved first). */
export async function openingCashThreshold(ctx: QueryCtx, businessUnitId: Id<"businessUnits">): Promise<number> {
  const settings = await ctx.db
    .query("cashSettings")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", businessUnitId))
    .unique();
  return settings?.openingCashApprovalThreshold ?? 0;
}

/** Whether an amount must go through Approvals. */
export function needsApproval(amount: number, threshold: number): boolean {
  return amount > threshold;
}

/** The reversal of a record that is pending or approved (rejected ones don't count). */
export async function activeReversalOf(ctx: QueryCtx, recordId: Id<"openingCash">) {
  const reversals = await ctx.db
    .query("openingCash")
    .withIndex("by_reversesId", (q) => q.eq("reversesId", recordId))
    .take(50);
  return reversals.find((r) => r.status !== "rejected") ?? null;
}

/**
 * Applies an approved row to Cash on hand. For a reversal, re-checks its
 * record is still approved and not reversed by another row.
 */
export async function applyApprovedOpeningCash(ctx: MutationCtx, row: Doc<"openingCash">) {
  if (row.kind === "reversal") {
    const record = row.reversesId ? await ctx.db.get("openingCash", row.reversesId) : null;
    if (!record || record.status !== "approved") throw new ConvexError("This opening cash can't be reversed any more.");
    const reversal = await activeReversalOf(ctx, record._id);
    if (reversal && reversal._id !== row._id) throw new ConvexError("This opening cash is already reversed.");
  }
  await applyRollupEvent(ctx, row.businessUnitId, openingCashEvent(row));
}

async function pendingRowFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const row = await ctx.db.get("openingCash", approval.entityId as Id<"openingCash">);
  if (!row || row.approvalId !== approval._id || row.status !== "pending") {
    throw new ConvexError("This opening cash is no longer waiting for this decision.");
  }
  return row;
}

async function decide(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">, status: "approved" | "rejected") {
  const row = await pendingRowFor(ctx, approval);
  const decided = { ...row, status, decidedAt: Date.now() };
  if (status === "approved") await applyApprovedOpeningCash(ctx, decided);
  await ctx.db.patch("openingCash", row._id, { status, decidedAt: decided.decidedAt });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "openingCash",
    entityId: row._id,
    businessUnitId: row.businessUnitId,
    before: { kind: row.kind, amount: row.amount, currency: row.currency, status: "pending" },
    after: { kind: row.kind, amount: row.amount, currency: row.currency, status },
  });
}

/** APPROVAL_HANDLERS.opening_cash. */
export async function applyOpeningCashApproval(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  await decide(ctx, approval, decider, "approved");
}

/** APPROVAL_REJECTION_HANDLERS.opening_cash (bookkeeping only). */
export async function applyOpeningCashRejection(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  await decide(ctx, approval, decider, "rejected");
}
