import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { isPermissionKey, type PermissionKey } from "./permissions";
import type { PermissionMap } from "./rbac";
import type { ApprovalType } from "./approvalTypes";

/**
 * The generic approval engine (CLAUDE.md "Approvals" / "Deletes"). A
 * feature never applies an approvable change directly: its mutation calls
 * `requestApproval`, and when someone else approves it,
 * `approvals.decideApproval` runs the type's handler from
 * `APPROVAL_HANDLERS` (convex/lib/approvalHandlers.ts).
 */

/** Who may decide each type, unless the request names another permission. */
export const DEFAULT_REQUIRED_PERMISSION: Record<ApprovalType, PermissionKey> = {
  sale_edit: "sales.edit.approve",
  delete: "deletes.approve",
  expense: "expenses.approve",
  payroll: "payroll.approve",
  requisition: "requisition.approve",
  stock_batch: "stock.approve",
  distribution: "stock.approve",
  withdrawal: "withdrawals.approve",
};

export type ApprovalRequest = {
  type: ApprovalType;
  businessUnitId: Id<"businessUnits">;
  /** Set when the change belongs to one location (scopes own_location deciders). */
  locationId?: Id<"locations">;
  entityTable: TableNames | (string & {});
  entityId: string;
  /**
   * The proposed change. Convention: `{ before?: {...}, after?: {...} }`
   * (plus any extra data the handler needs) so the Approvals page can show
   * a readable diff. Never secrets.
   */
  payload: Record<string, unknown>;
  reason?: string;
  requiredPermission?: PermissionKey;
};

/**
 * Whether `user` has the right to decide `approval` at all (regardless of
 * its status): holds the required permission, within scope, and isn't the
 * requester - nobody approves their own request (CLAUDE.md).
 */
export function hasDeciderRights(
  user: Doc<"users">,
  permissions: PermissionMap,
  approval: Doc<"approvals">,
): boolean {
  if (approval.requestedBy === user._id) return false;
  if (!isPermissionKey(approval.requiredPermission)) return false;
  const scope = permissions.get(approval.requiredPermission);
  if (scope === undefined) return false;
  if (scope === "all_locations") return true;
  return (
    approval.locationId !== undefined && approval.locationId === user.locationId
  );
}

/** Whether `user` can approve/reject `approval` right now. */
export function canDecide(
  user: Doc<"users">,
  permissions: PermissionMap,
  approval: Doc<"approvals">,
): boolean {
  return (
    approval.status === "pending" &&
    hasDeciderRights(user, permissions, approval)
  );
}

/** view_all sees everything; others their own requests + what they may decide. */
export function canSeeApproval(
  user: Doc<"users">,
  permissions: PermissionMap,
  approval: Doc<"approvals">,
): boolean {
  return (
    permissions.has("approvals.view_all") ||
    approval.requestedBy === user._id ||
    hasDeciderRights(user, permissions, approval)
  );
}

/**
 * Inserts a pending approval requested by `requestedBy` and audits it.
 * Rejects a second pending request of the same type for the same record.
 */
export async function insertApproval(
  ctx: MutationCtx,
  requestedBy: Id<"users">,
  request: ApprovalRequest,
): Promise<Id<"approvals">> {
  // Typed as a PermissionKey, but re-checked: callers may pass through data.
  const requiredPermission: string =
    request.requiredPermission ?? DEFAULT_REQUIRED_PERMISSION[request.type];
  if (!isPermissionKey(requiredPermission)) {
    throw new ConvexError(`Unknown permission "${requiredPermission}".`);
  }
  const alreadyPending = await ctx.db
    .query("approvals")
    .withIndex("by_entityTable_and_entityId", (q) =>
      q.eq("entityTable", request.entityTable).eq("entityId", request.entityId),
    )
    .filter((q) =>
      q.and(
        q.eq(q.field("status"), "pending"),
        q.eq(q.field("type"), request.type),
      ),
    )
    .first();
  if (alreadyPending) {
    throw new ConvexError("A request for this record is already pending.");
  }

  const reason = request.reason?.trim() || undefined;
  const approvalId = await ctx.db.insert("approvals", {
    businessUnitId: request.businessUnitId,
    ...(request.locationId ? { locationId: request.locationId } : {}),
    type: request.type,
    entityTable: request.entityTable,
    entityId: request.entityId,
    payload: request.payload,
    ...(reason ? { reason } : {}),
    status: "pending",
    requestedBy,
    requiredPermission,
  });
  await logAudit(ctx, {
    actorId: requestedBy,
    action: "create",
    entityTable: "approvals",
    entityId: approvalId,
    businessUnitId: request.businessUnitId,
    after: {
      type: request.type,
      entityTable: request.entityTable,
      entityId: request.entityId,
      requiredPermission,
      status: "pending",
      reason: reason ?? null,
    },
  });
  return approvalId;
}

/**
 * Requests approval for a change, from inside an authedMutation (the
 * signed-in caller is the requester). The feature's own mutation should
 * first check the caller may *request* it (e.g. `sales.edit.request`).
 */
export async function requestApproval(
  ctx: MutationCtx & { user: Doc<"users"> },
  request: ApprovalRequest,
): Promise<Id<"approvals">> {
  return await insertApproval(ctx, ctx.user._id, request);
}
