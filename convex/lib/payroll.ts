import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyRollupEvent, payrollEvent } from "./analytics";

/**
 * Payroll (CLAUDE.md "Payroll & withdrawals"): salary payments, submitted
 * as "pending" by anyone holding payroll.create and approved (approval type
 * "payroll", payroll.approve) by the Chief Admin - never by the submitter,
 * except the Super Admin (flagged). USD, integer cents. A period is a month.
 */

export const payrollStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
export type PayrollStatus = Infer<typeof payrollStatusValidator>;
export const PAYROLL_STATUSES = ["pending", "approved", "rejected"] as const;

/** A payroll period: a month, "YYYY-MM". */
export function isPeriod(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

/** `period` moved by `n` months. */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The pending entry an approval decides (a stale approval is refused). */
async function pendingEntryFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const entry = await ctx.db.get("payrollEntries", approval.entityId as Id<"payrollEntries">);
  if (!entry || entry.approvalId !== approval._id || entry.status !== "pending") {
    throw new ConvexError("This payroll entry is no longer waiting for this decision.");
  }
  return entry;
}

async function decide(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">, status: "approved" | "rejected") {
  const entry = await pendingEntryFor(ctx, approval);
  const decidedAt = Date.now();
  await ctx.db.patch("payrollEntries", entry._id, { status, decidedAt });
  // Analytics: approved payroll counts on the day it was approved.
  if (status === "approved") await applyRollupEvent(ctx, entry.businessUnitId, payrollEvent(entry, decidedAt));
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "payrollEntries",
    entityId: entry._id,
    businessUnitId: entry.businessUnitId,
    before: { worker: entry.workerName, period: entry.period, status: "pending" },
    after: { worker: entry.workerName, period: entry.period, status },
  });
}

/** APPROVAL_HANDLERS.payroll: the entry is approved (paid). */
export async function applyPayrollApproval(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  await decide(ctx, approval, decider, "approved");
}

/** APPROVAL_REJECTION_HANDLERS.payroll (bookkeeping only). */
export async function applyPayrollRejection(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  await decide(ctx, approval, decider, "rejected");
}
