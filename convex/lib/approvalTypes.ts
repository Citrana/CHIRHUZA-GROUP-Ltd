import { v, type Infer } from "convex/values";

/**
 * Every kind of change that goes through the approval engine. Adding a
 * type here forces (at compile time) a handler in APPROVAL_HANDLERS and a
 * default permission in DEFAULT_REQUIRED_PERMISSION, plus labels in
 * `Approvals.types.<type>` in messages/*.json.
 */
export const APPROVAL_TYPES = [
  "sale_edit",
  "delete",
  "expense",
  "payroll",
  "requisition",
  "stock_batch",
  "distribution",
  "withdrawal",
] as const;

export const approvalTypeValidator = v.union(
  v.literal("sale_edit"),
  v.literal("delete"),
  v.literal("expense"),
  v.literal("payroll"),
  v.literal("requisition"),
  v.literal("stock_batch"),
  v.literal("distribution"),
  v.literal("withdrawal"),
);
export type ApprovalType = Infer<typeof approvalTypeValidator>;

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;

export const approvalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);
export type ApprovalStatus = Infer<typeof approvalStatusValidator>;

export const approvalDecisionValidator = v.union(
  v.literal("approve"),
  v.literal("reject"),
);
