import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { nextSequenceNumber } from "./lib/requisitions";
import { distributionStatusValidator } from "./lib/distributions";
import { activeLocations } from "./lib/locationScope";
import {
  businessHolderRef,
  findHolder,
  getOrCreateHolder,
  holderName,
  stockLevelOf,
} from "./lib/inventory";
import { productDetails } from "./lib/products";

/**
 * Distributions (convex/lib/distributions.ts): stock.distribute submits
 * "send these lots from the business to this location/person"; the Chief
 * Admin (stock.approve) decides through the approval engine, whose handler
 * moves the stock. stock.view lists them.
 */

const MAX_LINES = 100;

/** Units of a lot already asked for by distributions still waiting for a decision. */
async function pendingQty(ctx: QueryCtx, inventoryBatchId: Id<"inventoryBatches">) {
  const items = await ctx.db
    .query("distributionItems")
    .withIndex("by_inventoryBatchId", (q) => q.eq("inventoryBatchId", inventoryBatchId))
    .take(500);
  let total = 0;
  for (const item of items) {
    const distribution = await ctx.db.get("distributions", item.distributionId);
    if (distribution?.status === "pending") total += item.qty;
  }
  return total;
}

async function describeProduct(ctx: QueryCtx, productId: Id<"products">) {
  const product = await ctx.db.get("products", productId);
  const details = await productDetails(ctx, product);
  return {
    productName: product?.name ?? null,
    sku: product?.sku ?? null,
    lengthInches: product?.lengthInches ?? null,
    colourName: details.colourName,
    sizeName: details.sizeName,
  };
}

/**
 * What a new distribution can use: lots at the business holder with the
 * quantity still available (on hand minus pending distributions), and the
 * destinations (active locations of the unit, active people with a role).
 */
export const options = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("stock.distribute");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const business = await findHolder(ctx, unit._id, businessHolderRef(unit._id));
    const levels = business
      ? await ctx.db
          .query("stockLevels")
          .withIndex("by_holderId", (q) => q.eq("holderId", business._id))
          .take(2000)
      : [];
    const lots = [];
    for (const level of levels) {
      if (level.qtyOnHand <= 0) continue;
      const lot = await ctx.db.get("inventoryBatches", level.inventoryBatchId);
      if (!lot) continue;
      const batch = await ctx.db.get("stockBatches", lot.stockBatchId);
      const available = level.qtyOnHand - (await pendingQty(ctx, lot._id));
      lots.push({
        _id: lot._id,
        ...(await describeProduct(ctx, lot.productId)),
        batchNumber: batch?.number ?? null,
        unitCost: lot.unitCost,
        onHand: level.qtyOnHand,
        available: Math.max(0, available),
      });
    }
    lots.sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? ""));

    const locations = (await activeLocations(ctx)).map((l) => ({ _id: l._id, name: l.name, type: l.type }));
    const people = (await ctx.db.query("users").take(1000))
      .filter((u) => u.status === "active" && u.roleId !== null)
      .map((u) => ({ _id: u._id, name: u.name, email: u.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { lots, locations, people };
  },
});

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    to: v.union(
      v.object({ type: v.literal("location"), id: v.id("locations") }),
      v.object({ type: v.literal("user"), id: v.id("users") }),
    ),
    lines: v.array(v.object({ inventoryBatchId: v.id("inventoryBatches"), qty: v.number() })),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("stock.distribute");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);

    let destination: string;
    if (args.to.type === "location") {
      const location = await ctx.db.get("locations", args.to.id);
      if (!location || !location.active) {
        throw new ConvexError("Choose an active location.");
      }
      destination = location.name;
    } else {
      const person = await ctx.db.get("users", args.to.id);
      if (!person || person.status !== "active") {
        throw new ConvexError("Choose an active person.");
      }
      destination = person.name;
    }

    if (args.lines.length === 0) throw new ConvexError("Add at least one line.");
    if (args.lines.length > MAX_LINES) throw new ConvexError(`At most ${MAX_LINES} lines.`);
    if (new Set(args.lines.map((l) => l.inventoryBatchId)).size !== args.lines.length) {
      throw new ConvexError("Each lot can appear only once.");
    }
    const note = args.note?.trim() || undefined;
    if (note && note.length > 500) throw new ConvexError("Note is too long.");

    const business = await findHolder(ctx, unit._id, businessHolderRef(unit._id));
    const described = [];
    for (const line of args.lines) {
      if (!Number.isSafeInteger(line.qty) || line.qty < 1) {
        throw new ConvexError("Quantities must be whole numbers from 1.");
      }
      const lot = await ctx.db.get("inventoryBatches", line.inventoryBatchId);
      if (!lot || lot.businessUnitId !== unit._id) throw new ConvexError("Stock lot not found.");
      const level = business ? await stockLevelOf(ctx, lot._id, business._id) : null;
      const available = (level?.qtyOnHand ?? 0) - (await pendingQty(ctx, lot._id));
      const product = await describeProduct(ctx, lot.productId);
      if (line.qty > available) {
        throw new ConvexError({
          code: "INSUFFICIENT_STOCK" as const,
          message: `Only ${Math.max(0, available)} of ${product.productName ?? "this product"} available.`,
          inventoryBatchId: lot._id,
          available: Math.max(0, available),
        });
      }
      const batch = await ctx.db.get("stockBatches", lot.stockBatchId);
      // The `items` line shape the Approvals page lists (isLineItems).
      described.push({
        product: product.productName ?? "—",
        lengthInches: product.lengthInches,
        size: product.sizeName,
        colour: product.colourName,
        sku: product.sku,
        batch: batch?.number ?? null,
        qty: line.qty,
      });
    }

    const toHolderId = await getOrCreateHolder(ctx, unit._id, { type: args.to.type, refId: args.to.id } as
      | { type: "location"; refId: Id<"locations"> }
      | { type: "user"; refId: Id<"users"> });
    const number = await nextSequenceNumber(ctx, unit._id, "distribution", "DIST");
    const distributionId = await ctx.db.insert("distributions", {
      businessUnitId: unit._id,
      number,
      toHolderId,
      status: "pending",
      createdBy: ctx.user._id,
      ...(note ? { note } : {}),
    });
    for (const line of args.lines) {
      await ctx.db.insert("distributionItems", { distributionId, inventoryBatchId: line.inventoryBatchId, qty: line.qty });
    }
    const summary = {
      number,
      to: destination,
      items: described,
      totalQty: args.lines.reduce((s, l) => s + l.qty, 0),
    };
    const approvalId = await requestApproval(ctx, {
      type: "distribution",
      businessUnitId: unit._id,
      ...(args.to.type === "location" ? { locationId: args.to.id } : {}),
      entityTable: "distributions",
      entityId: distributionId,
      payload: { after: summary },
      ...(note ? { reason: note } : {}),
    });
    await ctx.db.patch("distributions", distributionId, { approvalId });
    await ctx.audit({
      action: "create",
      entityTable: "distributions",
      entityId: distributionId,
      businessUnitId: unit._id,
      after: { ...summary, status: "pending", note: note ?? null },
    });
    return distributionId;
  },
});

/** A distribution with its destination, lines and people, for the list. */
async function describeDistribution(ctx: AuthedQueryCtx, distribution: Doc<"distributions">) {
  const holder = await ctx.db.get("holders", distribution.toHolderId);
  const items = await ctx.db
    .query("distributionItems")
    .withIndex("by_distributionId", (q) => q.eq("distributionId", distribution._id))
    .take(MAX_LINES);
  const lines = await Promise.all(
    items.map(async (item) => {
      const lot = await ctx.db.get("inventoryBatches", item.inventoryBatchId);
      const batch = lot ? await ctx.db.get("stockBatches", lot.stockBatchId) : null;
      return {
        _id: item._id,
        qty: item.qty,
        inventoryBatchId: item.inventoryBatchId,
        batchNumber: batch?.number ?? null,
        ...(lot ? await describeProduct(ctx, lot.productId) : { productName: null, sku: null, lengthInches: null, sizeName: null, colourName: null }),
      };
    }),
  );
  const creator = await ctx.db.get("users", distribution.createdBy);
  const approval = distribution.approvalId ? await ctx.db.get("approvals", distribution.approvalId) : null;
  const decider = approval?.decidedBy ? await ctx.db.get("users", approval.decidedBy) : null;
  return {
    ...distribution,
    toType: holder?.type ?? null,
    toName: holder ? await holderName(ctx, holder) : null,
    lines,
    totalQty: lines.reduce((s, l) => s + l.qty, 0),
    createdByName: creator?.name ?? null,
    decidedByName: decider?.name ?? null,
    decisionNote: approval?.decisionNote ?? null,
  };
}

export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    status: v.optional(distributionStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { businessUnitKey, status, paginationOpts }) => {
    const { scope } = await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const result = status
      ? await ctx.db
          .query("distributions")
          .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("distributions")
          .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
          .order("desc")
          .paginate(paginationOpts);
    let page = result.page;
    if (scope === "own_location") {
      // Only what was sent to the viewer's location or to them.
      const mine = new Set<string>();
      for (const ref of [
        ...(ctx.user.locationId ? [{ type: "location" as const, refId: ctx.user.locationId }] : []),
        { type: "user" as const, refId: ctx.user._id },
      ]) {
        const holder = await findHolder(ctx, unit._id, ref);
        if (holder) mine.add(holder._id);
      }
      page = page.filter((d) => mine.has(d.toHolderId));
    }
    return { ...result, page: await Promise.all(page.map((d) => describeDistribution(ctx, d))) };
  },
});
