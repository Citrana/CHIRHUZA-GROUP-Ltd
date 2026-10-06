import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authedMutation,
  authedQuery,
  type AuthedMutationCtx,
  type AuthedQueryCtx,
} from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { diff } from "./lib/audit";
import {
  businessUnitKeyValidator,
  requireBusinessUnit,
} from "./lib/businessUnits";
import {
  isEditable,
  nextSequenceNumber,
  requisitionStatusValidator,
} from "./lib/requisitions";
import type { Scope } from "./lib/permissions";
import { productDetails } from "./lib/products";
import { activeLocations } from "./lib/locationScope";

/**
 * Requisitions (see convex/lib/requisitions.ts). Created and edited by
 * their creator (requisition.create) while draft or rejected; submitted to
 * the approval engine; visible to everyone with requisition.view.
 */

const MAX_QTY = 100_000;

function cleanNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 500) throw new ConvexError("Note is too long.");
  return trimmed;
}

function assertQty(qty: number) {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new ConvexError(`Quantity must be a whole number from 1 to ${MAX_QTY}.`);
  }
}

/** An active location (locations serve every service), within the caller's scope. */
async function assertLocationAllowed(
  ctx: AuthedQueryCtx,
  locationId: Id<"locations">,
  scope: Scope,
) {
  const location = await ctx.db.get("locations", locationId);
  if (!location || !location.active) {
    throw new ConvexError("Choose an active location.");
  }
  if (scope === "own_location" && ctx.user.locationId !== locationId) {
    throw new ConvexError("You can only create requisitions for your own location.");
  }
  return location;
}

/**
 * The requisition, if the caller may change it: they created it (or are
 * the Super Admin), still hold requisition.create, and it's a draft or a
 * rejected one being revised. Returns the caller's requisition.create scope.
 */
async function requireEditable(
  ctx: AuthedMutationCtx,
  requisitionId: Id<"requisitions">,
) {
  const { scope } = await ctx.requirePermission("requisition.create");
  const requisition = await ctx.db.get("requisitions", requisitionId);
  if (!requisition) throw new ConvexError("Requisition not found.");
  if (requisition.createdBy !== ctx.user._id && !ctx.isSuperAdmin) {
    throw new ConvexError("Only the person who created this requisition can change it.");
  }
  if (!isEditable(requisition.status)) {
    throw new ConvexError(
      requisition.status === "submitted"
        ? "This requisition is waiting for approval and can't be changed."
        : "Approved requisitions can't be changed. Create a new one.",
    );
  }
  return { requisition, scope };
}

async function itemsOf(ctx: QueryCtx, requisitionId: Id<"requisitions">) {
  return await ctx.db
    .query("requisitionItems")
    .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisitionId))
    .take(500);
}

async function userName(ctx: QueryCtx, userId: Id<"users"> | undefined) {
  if (!userId) return null;
  const user = await ctx.db.get("users", userId);
  return user?.name || user?.email || null;
}

function canViewAll(ctx: AuthedQueryCtx) {
  return ctx.can("requisition.view");
}

/**
 * Requisitions of a service, newest first. With requisition.view: all of
 * them (drafts included); otherwise only the caller's own.
 */
export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    paginationOpts: paginationOptsValidator,
    status: v.optional(requisitionStatusValidator),
  },
  handler: async (ctx, { businessUnitKey, paginationOpts, status }) => {
    const viewAll = canViewAll(ctx);
    if (!viewAll) {
      await ctx.requirePermission("requisition.create");
    }
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const table = ctx.db.query("requisitions");
    const result = !viewAll
      ? await table
          .withIndex("by_businessUnitId_and_createdBy", (q) =>
            q.eq("businessUnitId", unit._id).eq("createdBy", ctx.user._id),
          )
          .filter((q) => (status ? q.eq(q.field("status"), status) : true))
          .order("desc")
          .paginate(paginationOpts)
      : status
        ? await table
            .withIndex("by_businessUnitId_and_status", (q) =>
              q.eq("businessUnitId", unit._id).eq("status", status),
            )
            .order("desc")
            .paginate(paginationOpts)
        : await table
            .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
            .order("desc")
            .paginate(paginationOpts);

    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (r) => {
          const location = await ctx.db.get("locations", r.locationId);
          return {
            ...r,
            locationName: location?.name ?? null,
            createdByName: await userName(ctx, r.createdBy),
            itemCount: (await itemsOf(ctx, r._id)).length,
          };
        }),
      ),
    };
  },
});

/** One requisition with its items, latest approval and what the caller may do. */
export const get = authedQuery({
  args: { requisitionId: v.string() },
  handler: async (ctx, args) => {
    const requisitionId = ctx.db.normalizeId("requisitions", args.requisitionId);
    const requisition = requisitionId ? await ctx.db.get("requisitions", requisitionId) : null;
    if (!requisition) return null;
    const mine = requisition.createdBy === ctx.user._id;
    if (!canViewAll(ctx) && !mine) return null;

    const [location, unit, rawItems] = await Promise.all([
      ctx.db.get("locations", requisition.locationId),
      ctx.db.get("businessUnits", requisition.businessUnitId),
      itemsOf(ctx, requisition._id),
    ]);
    const items = await Promise.all(
      rawItems.map(async (item) => {
        const product = await ctx.db.get("products", item.productId);
        const details = await productDetails(ctx, product);
        // How purchasing went for this line: the batch line(s) that took it.
        const batchLines = await ctx.db
          .query("stockBatchItems")
          .withIndex("by_requisitionItemId", (q) => q.eq("requisitionItemId", item._id))
          .take(10);
        const purchases = await Promise.all(
          batchLines.map(async (line) => {
            const batch = await ctx.db.get("stockBatches", line.batchId);
            return {
              batchNumber: batch?.number ?? null,
              batchStatus: batch?.status ?? null,
              status: line.status,
              qtyPurchased: line.qtyPurchased,
              reason: line.reason ?? null,
            };
          }),
        );
        return {
          ...item,
          productName: product?.name ?? null,
          sku: product?.sku ?? null,
          lengthInches: product?.lengthInches ?? null,
          colourName: details.colourName,
          sizeName: details.sizeName,
          purchases,
        };
      }),
    );
    const approval = requisition.approvalId
      ? await ctx.db.get("approvals", requisition.approvalId)
      : null;
    const canEdit =
      (mine || ctx.isSuperAdmin) &&
      isEditable(requisition.status) &&
      ctx.can("requisition.create");

    return {
      ...requisition,
      businessUnitKey: unit?.key ?? null,
      locationName: location?.name ?? null,
      createdByName: await userName(ctx, requisition.createdBy),
      items: items.sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? "")),
      approval: approval
        ? {
            _id: approval._id,
            status: approval.status,
            decidedByName: await userName(ctx, approval.decidedBy),
            decidedAt: approval.decidedAt ?? null,
            decisionNote: approval.decisionNote ?? null,
          }
        : null,
      canEdit,
      // Empty is fine with a note: the buyer then chooses the products.
      canSubmit: canEdit && (items.length > 0 || Boolean(requisition.note?.trim())),
      isOpen: items.length === 0,
    };
  },
});

/**
 * Locations the caller may create requisitions for: active locations of
 * the service - only their own when their requisition.create scope is
 * own_location.
 */
export const locationOptions = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("requisition.create");
    await requireBusinessUnit(ctx, businessUnitKey);
    return (await activeLocations(ctx))
      .filter((l) => scope === "all_locations" || l._id === ctx.user.locationId)
      .map((l) => ({ _id: l._id, name: l.name, type: l.type }));
  },
});

/** Starts a draft requisition for a location of the service. */
export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    locationId: v.id("locations"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("requisition.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const location = await assertLocationAllowed(ctx, args.locationId, scope);
    const note = cleanNote(args.note);
    const number = await nextSequenceNumber(ctx, unit._id, "requisition", "REQ");
    const requisitionId = await ctx.db.insert("requisitions", {
      businessUnitId: unit._id,
      locationId: args.locationId,
      number,
      ...(note ? { note } : {}),
      status: "draft",
      createdBy: ctx.user._id,
    });
    await ctx.audit({
      action: "create",
      entityTable: "requisitions",
      entityId: requisitionId,
      businessUnitId: unit._id,
      after: { number, location: location.name, note: note ?? null, status: "draft" },
    });
    return requisitionId;
  },
});

/** Changes a draft's (or rejected one's) location or note. */
export const update = authedMutation({
  args: {
    requisitionId: v.id("requisitions"),
    locationId: v.id("locations"),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { requisition, scope } = await requireEditable(ctx, args.requisitionId);
    const location = await assertLocationAllowed(ctx, args.locationId, scope);
    const previousLocation = await ctx.db.get("locations", requisition.locationId);
    const note = cleanNote(args.note);
    const changes = diff(
      { location: previousLocation?.name ?? null, note: requisition.note ?? null },
      { location: location.name, note: note ?? null },
    );
    if (!changes) return;
    await ctx.db.patch("requisitions", requisition._id, { locationId: args.locationId, note });
    await ctx.audit({
      action: "update",
      entityTable: "requisitions",
      entityId: requisition._id,
      businessUnitId: requisition.businessUnitId,
      ...changes,
    });
  },
});

async function describeItem(
  ctx: QueryCtx,
  requisition: Doc<"requisitions">,
  item: { productId: Id<"products">; qtyRequested: number; note?: string },
) {
  const product = await ctx.db.get("products", item.productId);
  return {
    requisition: requisition.number,
    product: product?.name ?? null,
    sku: product?.sku ?? null,
    qtyRequested: item.qtyRequested,
    note: item.note ?? null,
  };
}

/** Adds a product line. Active products of the same service; one line per product. */
export const addItem = authedMutation({
  args: {
    requisitionId: v.id("requisitions"),
    productId: v.id("products"),
    qtyRequested: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { requisition } = await requireEditable(ctx, args.requisitionId);
    assertQty(args.qtyRequested);
    const product = await ctx.db.get("products", args.productId);
    if (!product || product.businessUnitId !== requisition.businessUnitId || product.status !== "active") {
      throw new ConvexError("Choose an active product of this service.");
    }
    const existing = await ctx.db
      .query("requisitionItems")
      .withIndex("by_requisitionId_and_productId", (q) =>
        q.eq("requisitionId", requisition._id).eq("productId", args.productId),
      )
      .unique();
    if (existing) {
      throw new ConvexError("This product is already on the requisition. Change its quantity instead.");
    }
    const note = cleanNote(args.note);
    const item = { productId: args.productId, qtyRequested: args.qtyRequested, ...(note ? { note } : {}) };
    const itemId = await ctx.db.insert("requisitionItems", {
      requisitionId: requisition._id,
      ...item,
      resolution: "pending",
    });
    await ctx.audit({
      action: "create",
      entityTable: "requisitionItems",
      entityId: itemId,
      businessUnitId: requisition.businessUnitId,
      after: await describeItem(ctx, requisition, item),
    });
    return itemId;
  },
});

/** Changes a line's quantity or note. */
export const updateItem = authedMutation({
  args: {
    itemId: v.id("requisitionItems"),
    qtyRequested: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get("requisitionItems", args.itemId);
    if (!item) throw new ConvexError("Line not found.");
    const { requisition } = await requireEditable(ctx, item.requisitionId);
    assertQty(args.qtyRequested);
    const note = cleanNote(args.note);
    const changes = diff(
      { qtyRequested: item.qtyRequested, note: item.note ?? null },
      { qtyRequested: args.qtyRequested, note: note ?? null },
    );
    if (!changes) return;
    await ctx.db.patch("requisitionItems", item._id, { qtyRequested: args.qtyRequested, note });
    const product = await ctx.db.get("products", item.productId);
    await ctx.audit({
      action: "update",
      entityTable: "requisitionItems",
      entityId: item._id,
      businessUnitId: requisition.businessUnitId,
      before: { requisition: requisition.number, product: product?.name ?? null, ...changes.before },
      after: { requisition: requisition.number, product: product?.name ?? null, ...changes.after },
    });
  },
});

/**
 * Removes a line from your own draft (or rejected requisition being
 * revised). This edits a draft rather than deleting a business record, so
 * it needs no approval - but it is audited.
 */
export const removeItem = authedMutation({
  args: { itemId: v.id("requisitionItems") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get("requisitionItems", itemId);
    if (!item) throw new ConvexError("Line not found.");
    const { requisition } = await requireEditable(ctx, item.requisitionId);
    const before = await describeItem(ctx, requisition, item);
    await ctx.db.delete("requisitionItems", itemId);
    await ctx.audit({
      action: "delete",
      entityTable: "requisitionItems",
      entityId: itemId,
      businessUnitId: requisition.businessUnitId,
      before,
    });
  },
});

/**
 * Sends the requisition for approval (type "requisition", decided by
 * requisition.approve - never by its creator). Also used to resubmit a
 * rejected one after revising it.
 */
export const submit = authedMutation({
  args: { requisitionId: v.id("requisitions") },
  handler: async (ctx, { requisitionId }) => {
    const { requisition } = await requireEditable(ctx, requisitionId);
    const items = await itemsOf(ctx, requisition._id);
    // An empty requisition is fine: the buyer chooses the products while
    // purchasing - but it must say what's needed.
    if (items.length === 0 && !requisition.note?.trim()) {
      throw new ConvexError("Say what's needed in the note, or add products, before submitting.");
    }
    const location = await ctx.db.get("locations", requisition.locationId);
    const lines = await Promise.all(
      items.map(async (item) => {
        const product = await ctx.db.get("products", item.productId);
        return `${product?.name ?? "?"} (${product?.sku ?? "?"}) × ${item.qtyRequested}`;
      }),
    );
    const approvalId = await requestApproval(ctx, {
      type: "requisition",
      businessUnitId: requisition.businessUnitId,
      locationId: requisition.locationId,
      entityTable: "requisitions",
      entityId: requisition._id,
      payload: {
        after: {
          number: requisition.number,
          location: location?.name ?? null,
          itemCount: items.length,
          items: lines.sort().join("; "),
        },
      },
      reason: requisition.note,
    });
    await ctx.db.patch("requisitions", requisition._id, {
      status: "submitted",
      submittedAt: Date.now(),
      approvalId,
    });
    await ctx.audit({
      action: "update",
      entityTable: "requisitions",
      entityId: requisition._id,
      businessUnitId: requisition.businessUnitId,
      before: { number: requisition.number, status: requisition.status },
      after: { number: requisition.number, status: "submitted" },
    });
    return approvalId;
  },
});
