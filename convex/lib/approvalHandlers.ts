import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { ApprovalType } from "./approvalTypes";
import { deleteApprovedProduct } from "./products";
import { applyPayrollApproval, applyPayrollRejection } from "./payroll";
import { applyWithdrawalApproval, applyWithdrawalRejection } from "./withdrawals";
import {
  applyDistributionApproval,
  applyDistributionRejection,
} from "./distributions";
import {
  applyRequisitionApproval,
  applyRequisitionRejection,
} from "./requisitions";
import {
  applyStockBatchApproval,
  applyStockBatchRejection,
} from "./stockBatches";

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
 * Business-data deletes (CLAUDE.md "Deletes") all use the one `delete`
 * approval type; this picks the table's own delete handler by
 * `approval.entityTable`. To make a table deletable, add it here. An
 * unregistered table throws, so its approval stays pending.
 */
export const DELETE_HANDLERS: Record<string, ApprovalHandler> = {
  products: deleteApprovedProduct,
};

const dispatchDelete: ApprovalHandler = async (ctx, approval, decider) => {
  const handler = DELETE_HANDLERS[approval.entityTable];
  if (!handler) {
    throw new ConvexError(
      `Deleting "${approval.entityTable}" records isn't supported yet.`,
    );
  }
  await handler(ctx, approval, decider);
};

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
  delete: dispatchDelete,
  expense: notImplementedYet,
  payroll: applyPayrollApproval,
  requisition: applyRequisitionApproval,
  stock_batch: applyStockBatchApproval,
  distribution: applyDistributionApproval,
  withdrawal: applyWithdrawalApproval,
};

/**
 * Optional per-type rejection hooks, run by `decideApproval` in the same
 * transaction when an approval is rejected. For status bookkeeping ONLY
 * (e.g. marking a requisition "rejected") - never to apply a change: a
 * rejection changes nothing but the state of the request itself.
 */
export const APPROVAL_REJECTION_HANDLERS: Partial<Record<ApprovalType, ApprovalHandler>> = {
  requisition: applyRequisitionRejection,
  stock_batch: applyStockBatchRejection,
  distribution: applyDistributionRejection,
  payroll: applyPayrollRejection,
  withdrawal: applyWithdrawalRejection,
};
