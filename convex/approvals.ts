import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, type PermissionMap } from "./lib/rbac";
import {
  canDecide,
  canSeeApproval,
  countDecidable,
  insertApproval,
} from "./lib/approvals";
import {
  APPROVAL_HANDLERS,
  APPROVAL_REJECTION_HANDLERS,
} from "./lib/approvalHandlers";
import {
  approvalDecisionValidator,
  approvalStatusValidator,
  approvalTypeValidator,
} from "./lib/approvalTypes";
import {
  businessUnitKeyValidator,
  getBusinessUnitByKey,
} from "./lib/businessUnits";
import { isPermissionKey, PERMISSION_KEYS } from "./lib/permissions";

/**
 * Approves or rejects a pending approval. The decider must hold the
 * approval's `requiredPermission` (within scope) and must not be the
 * requester. Approving runs the type's handler first - if it throws, the
 * whole transaction rolls back and the approval stays pending. Rejecting
 * changes nothing but the approval. Both are audited.
 */
export const decideApproval = authedMutation({
  args: {
    approvalId: v.id("approvals"),
    decision: approvalDecisionValidator,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { approvalId, decision, note }) => {
    const approval = await ctx.db.get("approvals", approvalId);
    if (!approval) {
      throw new ConvexError("Approval not found.");
    }
    if (approval.status !== "pending") {
      throw new ConvexError("This approval has already been decided.");
    }
    if (!isPermissionKey(approval.requiredPermission)) {
      throw new ConvexError("This approval requires an unknown permission.");
    }
    await ctx.requirePermission(
      approval.requiredPermission,
      (scope, user) =>
        scope === "all_locations" ||
        (approval.locationId !== undefined &&
          approval.locationId === user.locationId),
    );
    // Separation of duties - except for the Super Admin (flagged in the audit).
    const selfDecision = approval.requestedBy === ctx.user._id;
    if (selfDecision && !ctx.isSuperAdmin) {
      throw new ConvexError("You cannot decide your own request.");
    }

    // Looked up at call time so features (and tests) can register handlers.
    if (decision === "approve") {
      await APPROVAL_HANDLERS[approval.type](ctx, approval, ctx.user);
    } else {
      // Status bookkeeping only (e.g. requisition -> "rejected").
      await APPROVAL_REJECTION_HANDLERS[approval.type]?.(ctx, approval, ctx.user);
    }

    const status = decision === "approve" ? "approved" : "rejected";
    const decisionNote = note?.trim() || undefined;
    await ctx.db.patch("approvals", approvalId, {
      status,
      decidedBy: ctx.user._id,
      decidedAt: Date.now(),
      ...(decisionNote ? { decisionNote } : {}),
    });
    await ctx.audit({
      action: decision,
      entityTable: "approvals",
      entityId: approvalId,
      businessUnitId: approval.businessUnitId,
      before: { status: "pending" },
      after: { status, ...(selfDecision ? { selfApproved: true } : {}) },
      ...(decisionNote ? { reason: decisionNote } : {}),
    });
  },
});

async function withNames(
  ctx: QueryCtx,
  user: Doc<"users">,
  permissions: PermissionMap,
  isSuperAdmin: boolean,
  approval: Doc<"approvals">,
) {
  const requester = await ctx.db.get("users", approval.requestedBy);
  const decider = approval.decidedBy
    ? await ctx.db.get("users", approval.decidedBy)
    : null;
  return {
    ...approval,
    requesterName: requester?.name || requester?.email || null,
    deciderName: decider?.name || decider?.email || null,
    canDecide: canDecide(user, permissions, approval, isSuperAdmin),
  };
}

/**
 * Approvals of one service, newest first, filtered by any mix of status,
 * type, "requested by me" and date range (UTC ms on the request time).
 * `approvals.view_all` sees everything; everyone else sees their own
 * requests plus the ones they have the right to decide.
 */
export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    paginationOpts: paginationOptsValidator,
    status: v.optional(approvalStatusValidator),
    type: v.optional(approvalTypeValidator),
    requestedByMe: v.optional(v.boolean()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const unit = await getBusinessUnitByKey(ctx, args.businessUnitKey);
    if (!unit) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const buId = unit._id;
    const me = ctx.user._id;
    const from = args.from ?? 0;
    const to = args.to ?? Number.MAX_SAFE_INTEGER;
    const { status, type } = args;
    const table = ctx.db.query("approvals");

    const indexed = args.requestedByMe
      ? table.withIndex("by_businessUnitId_and_requestedBy", (q) =>
          q
            .eq("businessUnitId", buId)
            .eq("requestedBy", me)
            .gte("_creationTime", from)
            .lte("_creationTime", to),
        )
      : status
        ? table.withIndex("by_businessUnitId_and_status", (q) =>
            q
              .eq("businessUnitId", buId)
              .eq("status", status)
              .gte("_creationTime", from)
              .lte("_creationTime", to),
          )
        : type
          ? table.withIndex("by_businessUnitId_and_type", (q) =>
              q
                .eq("businessUnitId", buId)
                .eq("type", type)
                .gte("_creationTime", from)
                .lte("_creationTime", to),
            )
          : table.withIndex("by_businessUnitId", (q) =>
              q
                .eq("businessUnitId", buId)
                .gte("_creationTime", from)
                .lte("_creationTime", to),
            );

    // Without view_all: own requests, or ones whose required permission
    // this user holds (own_location ones only at their location).
    const viewAll = ctx.permissions.has("approvals.view_all");
    const anywhere = PERMISSION_KEYS.filter(
      (k) => ctx.permissions.get(k) === "all_locations",
    );
    const atMyLocation = PERMISSION_KEYS.filter(
      (k) => ctx.permissions.get(k) === "own_location",
    );
    const myLocation = ctx.user.locationId;

    const result = await indexed
      .filter((q) =>
        q.and(
          status ? q.eq(q.field("status"), status) : true,
          type ? q.eq(q.field("type"), type) : true,
          viewAll
            ? true
            : q.or(
                q.eq(q.field("requestedBy"), me),
                ...anywhere.map((k) => q.eq(q.field("requiredPermission"), k)),
                ...(myLocation
                  ? atMyLocation.map((k) =>
                      q.and(
                        q.eq(q.field("requiredPermission"), k),
                        q.eq(q.field("locationId"), myLocation),
                      ),
                    )
                  : []),
              ),
        ),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(
        result.page.map((a) =>
          withNames(ctx, ctx.user, ctx.permissions, ctx.isSuperAdmin, a),
        ),
      ),
    };
  },
});

/** One approval for the detail drawer, or null if missing / not visible. */
export const get = authedQuery({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    const approval = await ctx.db.get("approvals", approvalId);
    if (
      !approval ||
      !canSeeApproval(ctx.user, ctx.permissions, approval, ctx.isSuperAdmin)
    ) {
      return null;
    }
    return await withNames(ctx, ctx.user, ctx.permissions, ctx.isSuperAdmin, approval);
  },
});

/** How many pending approvals in this service the user can decide - the sidebar badge. */
export const pendingCount = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  returns: v.number(),
  handler: async (ctx, { businessUnitKey }) => {
    const unit = await getBusinessUnitByKey(ctx, businessUnitKey);
    if (!unit) return 0;
    return await countDecidable(ctx, unit._id);
  },
});

/**
 * CLI-only helper to try the engine before real features exist:
 *   pnpm dlx convex run approvals:createTestApproval '{"requestedByEmail":"you@example.com"}'
 * Creates a pending approval (default: an expense in Hair) with a sample
 * before/after payload. Internal - never callable from the browser.
 */
export const createTestApproval = internalMutation({
  args: {
    requestedByEmail: v.string(),
    type: v.optional(approvalTypeValidator),
    businessUnit: v.optional(businessUnitKeyValidator),
    reason: v.optional(v.string()),
  },
  returns: v.id("approvals"),
  handler: async (ctx, args): Promise<Id<"approvals">> => {
    const requester = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.requestedByEmail))
      .unique();
    if (!requester) {
      throw new ConvexError(`No user with email ${args.requestedByEmail}.`);
    }
    const unit = await getBusinessUnitByKey(ctx, args.businessUnit ?? "hair");
    if (!unit) {
      throw new ConvexError("Business unit not found. Run seed:seedReferenceData.");
    }
    return await insertApproval(ctx, requester._id, {
      type: args.type ?? "expense",
      businessUnitId: unit._id,
      entityTable: "test",
      entityId: `test-${Date.now()}`,
      payload: {
        before: { description: "Shop cleaning", amountMinor: 1200000, currency: "CDF" },
        after: { description: "Shop cleaning + supplies", amountMinor: 1500000, currency: "CDF" },
      },
      reason: args.reason ?? "Test approval created from the CLI.",
    });
  },
});
