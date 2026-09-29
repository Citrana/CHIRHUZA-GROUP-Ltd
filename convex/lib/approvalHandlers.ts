import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { ApprovalType } from "./approvalTypes";

/**
 * Applies an approved change. Runs inside `approvals.decideApproval`'s
 * transaction, *before* the approval is marked approved: if it throws,
 * nothing is applied and the approval stays pending. A handler must write
 * its own audit entries (logAudit, actor = `decider`) for the records it
 * changes. It is never called for rejections.
 */
export type ApprovalHandler = (
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
) => Promise<void>;

/** Placeholder until the owning feature registers its real handler. */
const notImplementedYet: ApprovalHandler = async () => {};

/**
 * The handler registry, one entry per approval type. `Record` makes a
 * missing type a compile error. To plug a feature in, replace its stub:
 *
 *   // convex/lib/approvalHandlers.ts
 *   import { applyExpenseApproval } from "../expenses";
 *   ...
 *   expense: applyExpenseApproval,
 *
 * where `applyExpenseApproval(ctx, approval, decider)` reads
 * `approval.payload` and writes the change.
 */
export const APPROVAL_HANDLERS: Record<ApprovalType, ApprovalHandler> = {
  sale_edit: notImplementedYet,
  delete: notImplementedYet,
  expense: notImplementedYet,
  payroll: notImplementedYet,
  requisition: notImplementedYet,
  stock_batch: notImplementedYet,
  distribution: notImplementedYet,
  withdrawal: notImplementedYet,
};
