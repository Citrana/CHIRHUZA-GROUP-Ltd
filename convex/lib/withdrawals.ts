import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";

/**
 * Withdrawals (CLAUDE.md "Payroll & withdrawals"): cash taken that serves
 * no business purpose. Requested by anyone holding withdrawals.request,
 * approved (approval type "withdrawal", withdrawals.approve) by the Chief
 * Admin. NOT a business cost: profit figures exclude them and analytics
 * shows them separately. USD, integer cents.
 */

export const withdrawalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
export type WithdrawalStatus = Infer<typeof withdrawalStatusValidator>;
export const WITHDRAWAL_STATUSES = ["pending", "approved", "rejected"] as const;

async function pendingWithdrawalFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const withdrawal = await ctx.db.get("withdrawals", approval.entityId as Id<"withdrawals">);
  if (!withdrawal || withdrawal.approvalId !== approval._id || withdrawal.status !== "pending") {
    throw new ConvexError("This withdrawal is no longer waiting for this decision.");
  }
  return withdrawal;
}

async function decide(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">, status: "approved" | "rejected") {
  const withdrawal = await pendingWithdrawalFor(ctx, approval);
  await ctx.db.patch("withdrawals", withdrawal._id, { status, decidedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "withdrawals",
    entityId: withdrawal._id,
    businessUnitId: withdrawal.businessUnitId,
    before: { amount: withdrawal.amount, currency: withdrawal.currency, status: "pending" },
    after: { amount: withdrawal.amount, currency: withdrawal.currency, status },
  });
}

/** APPROVAL_HANDLERS.withdrawal. */
export async function applyWithdrawalApproval(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  await decide(ctx, approval, decider, "approved");
}

/** APPROVAL_REJECTION_HANDLERS.withdrawal (bookkeeping only). */
export async function applyWithdrawalRejection(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  await decide(ctx, approval, decider, "rejected");
}
