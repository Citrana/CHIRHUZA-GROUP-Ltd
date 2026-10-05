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
import { nextSequenceNumber } from "./lib/requisitions";
import { applyMovement, businessHolderRef, getOrCreateHolder } from "./lib/inventory";
import { applyRollupEvent, expenseEvent } from "./lib/analytics";
import {
  batchItemStatusValidator,
  batchItems,
  expenseCategoryValidator,
  lineProblems,
  linkedRequisitionIds,
  missingQty,
  receiveProblems,
  receiptProblem,
  resolutionFor,
  stockBatchStatusValidator,
  syncBatchRequisitionLink,
  syncRequisitionStatus,
} from "./lib/stockBatches";
import { productDetails } from "./lib/products";

/**
 * Stock batches (see convex/lib/stockBatches.ts). stock.view to see;
 * stock.create to build and move a batch along (its creator, or the Super
 * Admin); stock.set_price to set unit costs; stock.approve decides the
 * approval; stock.receive marks arrival and receives the batch in Goma
 * (counting what arrived, which creates the sellable lots).
 */

const MAX_QTY = 1_000_000;

function cleanText(value: string | undefined, max: number, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new ConvexError(`${label} is too long.`);
  return trimmed;
}

function requireTitle(title: string) {
  const clean = cleanText(title, 120, "Title");
  if (!clean) throw new ConvexError("A title is required.");
  return clean;
}

function assertQty(qty: number, min: number) {
  if (!Number.isInteger(qty) || qty < min || qty > MAX_QTY) {
    throw new ConvexError(`Quantity must be a whole number from ${min}.`);
  }
}

function assertCents(amount: number, min: number, label: string) {
  if (!Number.isSafeInteger(amount) || amount < min) {
    throw new ConvexError(`${label} must be a whole number of cents >= ${min}.`);
  }
}

function isOwner(ctx: AuthedQueryCtx, batch: Doc<"stockBatches">) {
  return batch.createdBy === ctx.user._id || ctx.isSuperAdmin;
}

/**
 * The batch, if the caller may move it along: holds stock.create and
 * created it (or is the Super Admin). With `draft`, it must still be a
 * draft (fully editable; locked from "purchased" on).
 */
async function requireOwnBatch(
  ctx: AuthedMutationCtx,
  batchId: Id<"stockBatches">,
  { draft }: { draft: boolean },
) {
  await ctx.requirePermission("stock.create");
  const batch = await ctx.db.get("stockBatches", batchId);
  if (!batch) throw new ConvexError("Batch not found.");
  if (!isOwner(ctx, batch)) {
    throw new ConvexError("Only the person who created this batch can change it.");
  }
  if (draft && batch.status !== "draft") {
    throw new ConvexError("This batch is locked. Request a reopen to change it.");
  }
  return batch;
}

async function requireItemInDraft(ctx: AuthedMutationCtx, itemId: Id<"stockBatchItems">) {
  const item = await ctx.db.get("stockBatchItems", itemId);
  if (!item) throw new ConvexError("Line not found.");
  const batch = await requireOwnBatch(ctx, item.batchId, { draft: true });
  return { item, batch };
}

async function describeItem(ctx: QueryCtx, batch: Doc<"stockBatches">, item: Omit<Doc<"stockBatchItems">, "_id" | "_creationTime">) {
  const product = await ctx.db.get("products", item.productId);
  return {
    batch: batch.number,
    product: product?.name ?? null,
    sku: product?.sku ?? null,
    extra: item.requisitionItemId === undefined,
    status: item.status,
    qtyRequested: item.qtyRequested,
    qtyPurchased: item.qtyPurchased,
    unitCost: item.unitCost ?? null,
    currency: item.currency,
    reason: item.reason ?? null,
  };
}

/**
 * Totals from the current lines and expenses (cents). Expenses stay aside:
 * they're added to the grand total but never change product costs.
 */
function computeTotals(
  items: Doc<"stockBatchItems">[],
  expenses: Doc<"stockBatchExpenses">[],
) {
  let purchasedTotal = 0;
  for (const item of items) {
    if (item.status === "purchased" && item.unitCost !== undefined) {
      purchasedTotal += item.unitCost * item.qtyPurchased;
    }
  }
  const expensesTotal = expenses.reduce((s, e) => s + e.amount, 0);
  return { purchasedTotal, expensesTotal, grandTotal: purchasedTotal + expensesTotal };
}

/**
 * A batch's totals: the goods total is fixed when it's marked purchased;
 * expenses can be added at any time, so they're always summed live.
 */
function batchTotals(
  batch: Doc<"stockBatches">,
  items: Doc<"stockBatchItems">[],
  expenses: Doc<"stockBatchExpenses">[],
) {
  const live = computeTotals(items, expenses);
  const purchasedTotal = batch.status === "draft" ? live.purchasedTotal : (batch.purchasedTotal ?? 0);
  return { purchasedTotal, expensesTotal: live.expensesTotal, grandTotal: purchasedTotal + live.expensesTotal };
}

/**
 * Who may add, edit or remove a batch's expenses: its buyer (holds
 * stock.create and created it, or the Super Admin) at any status, and —
 * once it's no longer a draft — the Goma side (stock.receive,
 * stock.distribute or stock.approve), since transport and other costs are
 * paid along the way. Open even after "received", for late invoices.
 */
function mayEditExpenses(ctx: AuthedQueryCtx, batch: Doc<"stockBatches">) {
  if (isOwner(ctx, batch) && ctx.can("stock.create")) return true;
  return (
    batch.status !== "draft" &&
    (ctx.can("stock.receive") || ctx.can("stock.distribute") || ctx.can("stock.approve"))
  );
}

async function requireExpenseEditor(ctx: AuthedMutationCtx, batchId: Id<"stockBatches">) {
  await ctx.requirePermission("stock.view");
  const batch = await ctx.db.get("stockBatches", batchId);
  if (!batch) throw new ConvexError("Batch not found.");
  if (!mayEditExpenses(ctx, batch)) {
    throw new ConvexError("You can't change this batch's expenses.");
  }
  return batch;
}

async function expensesOf(ctx: QueryCtx, batchId: Id<"stockBatches">) {
  return await ctx.db
    .query("stockBatchExpenses")
    .withIndex("by_batchId", (q) => q.eq("batchId", batchId))
    .take(500);
}

async function itemsOf(ctx: QueryCtx, batchId: Id<"stockBatches">) {
  return await ctx.db
    .query("stockBatchItems")
    .withIndex("by_batchId", (q) => q.eq("batchId", batchId))
    .take(1000);
}

async function userName(ctx: QueryCtx, userId: Id<"users"> | undefined) {
  if (!userId) return null;
  const user = await ctx.db.get("users", userId);
  return user?.name || user?.email || null;
}

// ---------------------------------------------------------------- queries

export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    paginationOpts: paginationOptsValidator,
    status: v.optional(stockBatchStatusValidator),
  },
  handler: async (ctx, { businessUnitKey, paginationOpts, status }) => {
    await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const result = status
      ? await ctx.db
          .query("stockBatches")
          .withIndex("by_businessUnitId_and_status", (q) =>
            q.eq("businessUnitId", unit._id).eq("status", status),
          )
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("stockBatches")
          .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
          .order("desc")
          .paginate(paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (batch) => {
          const [items, expenses] = await Promise.all([itemsOf(ctx, batch._id), expensesOf(ctx, batch._id)]);
          const { grandTotal } = batchTotals(batch, items, expenses);
          return {
            ...batch,
            lineCount: items.length,
            grandTotal,
            createdByName: await userName(ctx, batch.createdBy),
          };
        }),
      ),
    };
  },
});

/** One batch with its lines, expenses, requisitions and what the caller may do. */
export const get = authedQuery({
  args: { batchId: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("stock.view");
    const batchId = ctx.db.normalizeId("stockBatches", args.batchId);
    const batch = batchId ? await ctx.db.get("stockBatches", batchId) : null;
    if (!batch) return null;

    const [unit, rawItems, rawExpenses, requisitionIds] = await Promise.all([
      ctx.db.get("businessUnits", batch.businessUnitId),
      itemsOf(ctx, batch._id),
      expensesOf(ctx, batch._id),
      ctx.db
        .query("stockBatchRequisitions")
        .withIndex("by_batchId_and_requisitionId", (q) => q.eq("batchId", batch._id))
        .take(500),
    ]);

    const items = await Promise.all(
      rawItems.map(async (item) => {
        const product = await ctx.db.get("products", item.productId);
        const details = await productDetails(ctx, product);
        const line = item.requisitionItemId ? await ctx.db.get("requisitionItems", item.requisitionItemId) : null;
        const requisition = line ? await ctx.db.get("requisitions", line.requisitionId) : null;
        return {
          ...item,
          productName: product?.name ?? null,
          sku: product?.sku ?? null,
          productStatus: product?.status ?? null,
          lengthInches: product?.lengthInches ?? null,
          colourName: details.colourName,
          sizeName: details.sizeName,
          requisitionId: requisition?._id ?? null,
          requisitionNumber: requisition?.number ?? null,
          problems: lineProblems(item),
          missing: item.status === "purchased" ? missingQty(item) : 0,
          inventoryBatchId:
            (
              await ctx.db
                .query("inventoryBatches")
                .withIndex("by_sourceStockBatchItemId", (q) => q.eq("sourceStockBatchItemId", item._id))
                .first()
            )?._id ?? null,
          receiveProblems: batch.status === "arrived" ? receiveProblems(item) : [],
        };
      }),
    );
    items.sort((a, b) =>
      (a.requisitionNumber ?? "~").localeCompare(b.requisitionNumber ?? "~") ||
      (a.productName ?? "").localeCompare(b.productName ?? ""),
    );

    const expenses = await Promise.all(
      rawExpenses.map(async (expense) => ({
        ...expense,
        receiptUrl: expense.receiptFileId ? await ctx.storage.getUrl(expense.receiptFileId) : null,
      })),
    );

    const requisitions = await Promise.all(
      requisitionIds.map(async (link) => {
        const requisition = await ctx.db.get("requisitions", link.requisitionId);
        const location = requisition ? await ctx.db.get("locations", requisition.locationId) : null;
        return {
          _id: link.requisitionId,
          number: requisition?.number ?? null,
          status: requisition?.status ?? null,
          locationName: location?.name ?? null,
        };
      }),
    );

    const approval = batch.approvalId ? await ctx.db.get("approvals", batch.approvalId) : null;
    const approvalKind = (approval?.payload as { kind?: string } | undefined)?.kind ?? null;
    const pendingApproval = approval?.status === "pending";
    const owner = isOwner(ctx, batch) && ctx.can("stock.create");
    const receiver = ctx.can("stock.receive");
    const totals = batchTotals(batch, rawItems, rawExpenses);

    return {
      ...batch,
      businessUnitKey: unit?.key ?? null,
      createdByName: await userName(ctx, batch.createdBy),
      receivedByName: batch.receivedBy ? await userName(ctx, batch.receivedBy) : null,
      items,
      expenses,
      requisitions,
      totals,
      approval: approval
        ? {
            _id: approval._id,
            kind: approvalKind,
            status: approval.status,
            decidedByName: await userName(ctx, approval.decidedBy),
            decisionNote: approval.decisionNote ?? null,
            reason: approval.reason ?? null,
          }
        : null,
      canEdit: owner && batch.status === "draft",
      canEditExpenses: mayEditExpenses(ctx, batch),
      canSetPrice: ctx.can("stock.set_price"),
      canSubmit: owner && batch.status === "purchased" && !pendingApproval,
      canRequestReopen: owner && batch.status === "purchased" && !pendingApproval,
      canShip: owner && batch.status === "approved",
      canMarkArrived: receiver && batch.status === "shipped",
      canReceive: receiver && batch.status === "arrived",
    };
  },
});

/**
 * Lines the batch builder may add: pending lines of APPROVED (or already
 * purchasing) requisitions of the service that aren't in any batch yet.
 */
export const requisitionOptions = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("stock.create");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const requisitions = [
      ...(await ctx.db
        .query("requisitions")
        .withIndex("by_businessUnitId_and_status", (q) =>
          q.eq("businessUnitId", unit._id).eq("status", "approved"),
        )
        .take(200)),
      ...(await ctx.db
        .query("requisitions")
        .withIndex("by_businessUnitId_and_status", (q) =>
          q.eq("businessUnitId", unit._id).eq("status", "purchasing"),
        )
        .take(200)),
    ];
    const options = await Promise.all(
      requisitions.map(async (requisition) => {
        const lines = await ctx.db
          .query("requisitionItems")
          .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisition._id))
          .take(500);
        const available = [];
        for (const line of lines) {
          if (line.resolution !== "pending") continue;
          const taken = await ctx.db
            .query("stockBatchItems")
            .withIndex("by_requisitionItemId", (q) => q.eq("requisitionItemId", line._id))
            .first();
          if (taken) continue;
          const product = await ctx.db.get("products", line.productId);
          const details = await productDetails(ctx, product);
          available.push({
            _id: line._id,
            productName: product?.name ?? null,
            sku: product?.sku ?? null,
            lengthInches: product?.lengthInches ?? null,
            colourName: details.colourName,
            sizeName: details.sizeName,
            qtyRequested: line.qtyRequested,
            note: line.note ?? null,
          });
        }
        const location = await ctx.db.get("locations", requisition.locationId);
        return {
          _id: requisition._id,
          number: requisition.number,
          status: requisition.status,
          locationName: location?.name ?? null,
          note: requisition.note ?? null,
          lines: available.sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? "")),
          // No lines at all: the buyer chooses the products (note says what).
          isOpen: lines.length === 0,
        };
      }),
    );
    return options
      .filter((r) => r.lines.length > 0 || r.isOpen)
      .sort((a, b) => a.number.localeCompare(b.number));
  },
});

// ------------------------------------------------------------ draft edits

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    title: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("stock.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const title = requireTitle(args.title);
    const description = cleanText(args.description, 1000, "Description");
    const number = await nextSequenceNumber(ctx, unit._id, "stockBatch", "BATCH");
    const batchId = await ctx.db.insert("stockBatches", {
      businessUnitId: unit._id,
      number,
      title,
      ...(description ? { description } : {}),
      status: "draft",
      currency: "USD",
      createdBy: ctx.user._id,
    });
    await ctx.audit({
      action: "create",
      entityTable: "stockBatches",
      entityId: batchId,
      businessUnitId: unit._id,
      after: { number, title, description: description ?? null, currency: "USD", status: "draft" },
    });
    return batchId;
  },
});

export const update = authedMutation({
  args: {
    batchId: v.id("stockBatches"),
    title: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batch = await requireOwnBatch(ctx, args.batchId, { draft: true });
    const next = {
      title: requireTitle(args.title),
      description: cleanText(args.description, 1000, "Description"),
    };
    const changes = diff(
      { title: batch.title, description: batch.description ?? null },
      { ...next, description: next.description ?? null },
    );
    if (!changes) return;
    await ctx.db.patch("stockBatches", batch._id, next);
    await ctx.audit({
      action: "update",
      entityTable: "stockBatches",
      entityId: batch._id,
      businessUnitId: batch.businessUnitId,
      ...changes,
    });
  },
});

/** Adds approved requisitions' pending lines (each starts "purchased", full qty, no cost yet). */
export const addRequisitionLines = authedMutation({
  args: {
    batchId: v.id("stockBatches"),
    requisitionItemIds: v.array(v.id("requisitionItems")),
  },
  handler: async (ctx, { batchId, requisitionItemIds }) => {
    const batch = await requireOwnBatch(ctx, batchId, { draft: true });
    if (requisitionItemIds.length === 0 || requisitionItemIds.length > 200) {
      throw new ConvexError("Choose between 1 and 200 lines.");
    }
    const touched = new Set<Id<"requisitions">>();
    for (const lineId of new Set(requisitionItemIds)) {
      const line = await ctx.db.get("requisitionItems", lineId);
      const requisition = line ? await ctx.db.get("requisitions", line.requisitionId) : null;
      if (
        !line ||
        !requisition ||
        requisition.businessUnitId !== batch.businessUnitId ||
        (requisition.status !== "approved" && requisition.status !== "purchasing")
      ) {
        throw new ConvexError("Only lines of approved requisitions of this service can be added.");
      }
      if (line.resolution !== "pending") {
        throw new ConvexError("This requisition line is already resolved.");
      }
      const taken = await ctx.db
        .query("stockBatchItems")
        .withIndex("by_requisitionItemId", (q) => q.eq("requisitionItemId", lineId))
        .first();
      if (taken) {
        throw new ConvexError("This requisition line is already in a batch.");
      }
      const item = {
        batchId: batch._id,
        productId: line.productId,
        requisitionItemId: lineId,
        status: "purchased" as const,
        qtyRequested: line.qtyRequested,
        qtyPurchased: line.qtyRequested,
        currency: "USD" as const,
      };
      const itemId = await ctx.db.insert("stockBatchItems", item);
      await ctx.audit({
        action: "create",
        entityTable: "stockBatchItems",
        entityId: itemId,
        businessUnitId: batch.businessUnitId,
        after: { ...(await describeItem(ctx, batch, item)), requisition: requisition.number },
      });
      touched.add(requisition._id);
    }
    for (const requisitionId of touched) {
      await syncBatchRequisitionLink(ctx, batch, requisitionId, ctx.user._id);
      await syncRequisitionStatus(ctx, requisitionId, ctx.user._id);
    }
  },
});

/**
 * Approved (or purchasing) requisitions the buyer can add products to, for
 * the "for which requisition?" choice: number, location, note, line count.
 */
export const targetRequisitions = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("stock.create");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const requisitions = [];
    for (const status of ["approved", "purchasing"] as const) {
      requisitions.push(
        ...(await ctx.db
          .query("requisitions")
          .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
          .take(200)),
      );
    }
    const rows = await Promise.all(
      requisitions.map(async (requisition) => {
        const location = await ctx.db.get("locations", requisition.locationId);
        const lines = await ctx.db
          .query("requisitionItems")
          .withIndex("by_requisitionId_and_productId", (q) => q.eq("requisitionId", requisition._id))
          .take(500);
        return {
          _id: requisition._id,
          number: requisition.number,
          locationName: location?.name ?? null,
          note: requisition.note ?? null,
          lineCount: lines.length,
        };
      }),
    );
    return rows.sort((a, b) => a.number.localeCompare(b.number));
  },
});

/**
 * Adds a product (active or pending confirmation) the buyer chose. Without
 * `requisitionId` it's an extra purchase. With one (an approved requisition
 * - e.g. an empty one that only says what's needed) it also becomes a line
 * of that requisition, flagged addedByBuyer, so the requisition follows the
 * purchase like any other line (no extra approval).
 */
export const addExtraItem = authedMutation({
  args: {
    batchId: v.id("stockBatches"),
    productId: v.id("products"),
    qtyPurchased: v.number(),
    unitCost: v.optional(v.number()),
    requisitionId: v.optional(v.id("requisitions")),
  },
  handler: async (ctx, args) => {
    const batch = await requireOwnBatch(ctx, args.batchId, { draft: true });
    const product = await ctx.db.get("products", args.productId);
    if (
      !product ||
      product.businessUnitId !== batch.businessUnitId ||
      (product.status !== "active" && product.status !== "pending_confirmation")
    ) {
      throw new ConvexError("Choose an active or pending product of this service.");
    }
    assertQty(args.qtyPurchased, 1);
    if (args.unitCost !== undefined) {
      await ctx.requirePermission("stock.set_price");
      assertCents(args.unitCost, 0, "Unit cost");
    }
    // For a requisition: the buyer's choice becomes one of its lines.
    let requisition: Doc<"requisitions"> | null = null;
    let requisitionItemId: Id<"requisitionItems"> | undefined;
    if (args.requisitionId) {
      requisition = await ctx.db.get("requisitions", args.requisitionId);
      if (
        !requisition ||
        requisition.businessUnitId !== batch.businessUnitId ||
        (requisition.status !== "approved" && requisition.status !== "purchasing")
      ) {
        throw new ConvexError("Only approved requisitions of this service can receive products.");
      }
      const existing = await ctx.db
        .query("requisitionItems")
        .withIndex("by_requisitionId_and_productId", (q) =>
          q.eq("requisitionId", requisition!._id).eq("productId", args.productId),
        )
        .take(50);
      if (existing.some((l) => l.resolution === "pending")) {
        throw new ConvexError("This product is already requested on that requisition - add that line from the requisition instead.");
      }
      const line = {
        requisitionId: requisition._id,
        productId: args.productId,
        qtyRequested: args.qtyPurchased,
        resolution: "pending" as const,
        addedByBuyer: true,
      };
      requisitionItemId = await ctx.db.insert("requisitionItems", line);
      await ctx.audit({
        action: "create",
        entityTable: "requisitionItems",
        entityId: requisitionItemId,
        businessUnitId: batch.businessUnitId,
        after: {
          requisition: requisition.number,
          product: product.name,
          sku: product.sku,
          qtyRequested: line.qtyRequested,
          addedByBuyer: true,
          batch: batch.number,
        },
      });
    }

    const item = {
      batchId: batch._id,
      productId: args.productId,
      ...(requisitionItemId ? { requisitionItemId } : {}),
      status: "purchased" as const,
      qtyRequested: requisitionItemId ? args.qtyPurchased : 0,
      qtyPurchased: args.qtyPurchased,
      ...(args.unitCost !== undefined ? { unitCost: args.unitCost } : {}),
      currency: "USD" as const,
    };
    const itemId = await ctx.db.insert("stockBatchItems", item);
    await ctx.audit({
      action: "create",
      entityTable: "stockBatchItems",
      entityId: itemId,
      businessUnitId: batch.businessUnitId,
      after: {
        ...(await describeItem(ctx, batch, item)),
        ...(requisition ? { requisition: requisition.number, addedByBuyer: true } : {}),
      },
    });
    if (requisition) {
      await syncBatchRequisitionLink(ctx, batch, requisition._id, ctx.user._id);
      await syncRequisitionStatus(ctx, requisition._id, ctx.user._id);
    }
    return itemId;
  },
});

/**
 * Updates a line (the UI autosaves each field). Not purchased lines keep
 * no quantity. Setting a unit cost needs stock.set_price.
 */
export const updateItem = authedMutation({
  args: {
    itemId: v.id("stockBatchItems"),
    status: batchItemStatusValidator,
    qtyPurchased: v.number(),
    unitCost: v.union(v.number(), v.null()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { item, batch } = await requireItemInDraft(ctx, args.itemId);
    const reason = cleanText(args.reason, 500, "Reason");
    const qtyPurchased = args.status === "not_purchased" ? 0 : args.qtyPurchased;
    assertQty(qtyPurchased, 0);
    const unitCost = args.unitCost ?? undefined;
    if (unitCost !== item.unitCost) {
      await ctx.requirePermission("stock.set_price");
    }
    if (unitCost !== undefined) assertCents(unitCost, 0, "Unit cost");

    const next = { ...item, status: args.status, qtyPurchased, unitCost, reason };
    const changes = diff(await describeItem(ctx, batch, item), await describeItem(ctx, batch, next));
    if (!changes) return;
    await ctx.db.patch("stockBatchItems", item._id, {
      status: args.status,
      qtyPurchased,
      unitCost,
      reason,
    });
    await ctx.audit({
      action: "update",
      entityTable: "stockBatchItems",
      entityId: item._id,
      businessUnitId: batch.businessUnitId,
      ...changes,
    });
  },
});

/** Removes a line from a draft; a requisition line becomes free for another batch. */
export const removeItem = authedMutation({
  args: { itemId: v.id("stockBatchItems") },
  handler: async (ctx, { itemId }) => {
    const { item, batch } = await requireItemInDraft(ctx, itemId);
    const before = await describeItem(ctx, batch, item);
    const line = item.requisitionItemId ? await ctx.db.get("requisitionItems", item.requisitionItemId) : null;
    await ctx.db.delete("stockBatchItems", itemId);
    await ctx.audit({
      action: "delete",
      entityTable: "stockBatchItems",
      entityId: itemId,
      businessUnitId: batch.businessUnitId,
      before,
    });
    if (line) {
      // A line the buyer added only existed for this purchase: remove it,
      // so the requisition is back to how it was approved.
      if (line.addedByBuyer) {
        await ctx.db.delete("requisitionItems", line._id);
        const requisition = await ctx.db.get("requisitions", line.requisitionId);
        await ctx.audit({
          action: "delete",
          entityTable: "requisitionItems",
          entityId: line._id,
          businessUnitId: batch.businessUnitId,
          before: {
            requisition: requisition?.number ?? null,
            product: before.product,
            qtyRequested: line.qtyRequested,
            addedByBuyer: true,
          },
        });
      }
      await syncBatchRequisitionLink(ctx, batch, line.requisitionId, ctx.user._id);
      await syncRequisitionStatus(ctx, line.requisitionId, ctx.user._id);
    }
  },
});

// ---------------------------------------------------------------- expenses

export const generateReceiptUploadUrl = authedMutation({
  args: { batchId: v.id("stockBatches") },
  handler: async (ctx, { batchId }) => {
    await requireExpenseEditor(ctx, batchId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** A receipt must be an image or a PDF, at most 10 MB. */
async function assertReceipt(ctx: AuthedMutationCtx, fileId: Id<"_storage">) {
  const file = await ctx.db.system.get("_storage", fileId);
  if (!file) throw new ConvexError("Receipt upload not found.");
  const problem = receiptProblem(file);
  if (problem === "type") throw new ConvexError("Receipts must be an image or a PDF.");
  if (problem === "size") throw new ConvexError("Receipts must be 10 MB or smaller.");
}

const expenseFields = {
  category: expenseCategoryValidator,
  amount: v.number(),
  note: v.optional(v.string()),
  receiptFileId: v.optional(v.id("_storage")),
};

function describeExpense(batch: Doc<"stockBatches">, e: Omit<Doc<"stockBatchExpenses">, "_id" | "_creationTime" | "batchId">) {
  return {
    batch: batch.number,
    category: e.category,
    amount: e.amount,
    currency: e.currency,
    note: e.note ?? null,
    receipt: e.receiptFileId ? "attached" : null,
  };
}

export const addExpense = authedMutation({
  args: { batchId: v.id("stockBatches"), ...expenseFields },
  handler: async (ctx, { batchId, ...args }) => {
    const batch = await requireExpenseEditor(ctx, batchId);
    assertCents(args.amount, 1, "Amount");
    if (args.receiptFileId) await assertReceipt(ctx, args.receiptFileId);
    const note = cleanText(args.note, 500, "Note");
    const expense = {
      category: args.category,
      amount: args.amount,
      currency: "USD" as const,
      ...(note ? { note } : {}),
      ...(args.receiptFileId ? { receiptFileId: args.receiptFileId } : {}),
    };
    const expenseId = await ctx.db.insert("stockBatchExpenses", { batchId, ...expense });
    // Analytics: trip expenses count on the day they're recorded.
    const inserted = (await ctx.db.get("stockBatchExpenses", expenseId))!;
    await applyRollupEvent(ctx, batch.businessUnitId, expenseEvent(inserted, expense.amount));
    await ctx.audit({
      action: "create",
      entityTable: "stockBatchExpenses",
      entityId: expenseId,
      businessUnitId: batch.businessUnitId,
      after: { ...describeExpense(batch, expense), batchStatus: batch.status },
    });
    return expenseId;
  },
});

export const updateExpense = authedMutation({
  args: { expenseId: v.id("stockBatchExpenses"), ...expenseFields },
  handler: async (ctx, { expenseId, ...args }) => {
    const expense = await ctx.db.get("stockBatchExpenses", expenseId);
    if (!expense) throw new ConvexError("Expense not found.");
    const batch = await requireExpenseEditor(ctx, expense.batchId);
    assertCents(args.amount, 1, "Amount");
    if (args.receiptFileId && args.receiptFileId !== expense.receiptFileId) {
      await assertReceipt(ctx, args.receiptFileId);
    }
    const note = cleanText(args.note, 500, "Note");
    const next = {
      category: args.category,
      amount: args.amount,
      currency: "USD" as const,
      note,
      receiptFileId: args.receiptFileId,
    };
    const changes = diff(describeExpense(batch, expense), describeExpense(batch, next));
    if (!changes) return;
    await ctx.db.patch("stockBatchExpenses", expenseId, next);
    if (next.amount !== expense.amount) {
      await applyRollupEvent(ctx, batch.businessUnitId, expenseEvent(expense, next.amount - expense.amount));
    }
    // A replaced or removed receipt file is no longer referenced.
    if (expense.receiptFileId && expense.receiptFileId !== args.receiptFileId) {
      await ctx.storage.delete(expense.receiptFileId);
    }
    await ctx.audit({
      action: "update",
      entityTable: "stockBatchExpenses",
      entityId: expenseId,
      businessUnitId: batch.businessUnitId,
      ...changes,
    });
  },
});

export const removeExpense = authedMutation({
  args: { expenseId: v.id("stockBatchExpenses") },
  handler: async (ctx, { expenseId }) => {
    const expense = await ctx.db.get("stockBatchExpenses", expenseId);
    if (!expense) throw new ConvexError("Expense not found.");
    const batch = await requireExpenseEditor(ctx, expense.batchId);
    await ctx.db.delete("stockBatchExpenses", expenseId);
    await applyRollupEvent(ctx, batch.businessUnitId, expenseEvent(expense, -expense.amount));
    if (expense.receiptFileId) await ctx.storage.delete(expense.receiptFileId);
    await ctx.audit({
      action: "delete",
      entityTable: "stockBatchExpenses",
      entityId: expenseId,
      businessUnitId: batch.businessUnitId,
      before: { ...describeExpense(batch, expense), batchStatus: batch.status },
    });
  },
});

// -------------------------------------------------------- purchase & after

/**
 * Locks the batch as purchased. Every line must be resolved (purchased
 * with a unit cost, or not purchased with a reason; fewer than requested
 * needs a reason). Fixes the goods total (expenses are kept aside, never
 * spread into product costs, and stay open) and writes the requisition
 * lines' resolutions, and closes
 * requisitions whose lines are all resolved.
 */
export const markPurchased = authedMutation({
  args: { batchId: v.id("stockBatches") },
  handler: async (ctx, { batchId }) => {
    const batch = await requireOwnBatch(ctx, batchId, { draft: true });
    const items = await batchItems(ctx, batch._id);
    if (items.length === 0) {
      throw new ConvexError("Add at least one line before marking the batch purchased.");
    }
    const incomplete = items
      .map((item) => ({ itemId: item._id, problems: lineProblems(item) }))
      .filter((line) => line.problems.length > 0);
    if (incomplete.length > 0) {
      throw new ConvexError({ code: "INCOMPLETE" as const, lines: incomplete });
    }

    const expenses = await expensesOf(ctx, batch._id);
    const totals = computeTotals(items, expenses);
    for (const item of items) {
      if (item.requisitionItemId) {
        await ctx.db.patch("requisitionItems", item.requisitionItemId, {
          resolution: resolutionFor(item),
        });
      }
    }
    await ctx.db.patch("stockBatches", batch._id, {
      status: "purchased",
      purchasedAt: Date.now(),
      purchasedTotal: totals.purchasedTotal,
    });
    for (const requisitionId of await linkedRequisitionIds(ctx, batch._id)) {
      await syncRequisitionStatus(ctx, requisitionId, ctx.user._id);
    }
    await ctx.audit({
      action: "update",
      entityTable: "stockBatches",
      entityId: batch._id,
      businessUnitId: batch.businessUnitId,
      before: { number: batch.number, status: "draft" },
      after: { number: batch.number, status: "purchased", currency: "USD", ...totals },
    });
  },
});

function summary(
  batch: Doc<"stockBatches">,
  items: Doc<"stockBatchItems">[],
  expenses: Doc<"stockBatchExpenses">[],
) {
  const purchasedLines = items.filter((i) => i.status === "purchased").length;
  return {
    number: batch.number,
    title: batch.title,
    purchasedLines,
    notPurchasedLines: items.length - purchasedLines,
    currency: "USD",
    // Expenses as of this moment; more can be added later.
    ...batchTotals(batch, items, expenses),
  };
}

async function requirePurchasedWithoutPendingApproval(ctx: AuthedMutationCtx, batchId: Id<"stockBatches">) {
  const batch = await requireOwnBatch(ctx, batchId, { draft: false });
  if (batch.status !== "purchased") {
    throw new ConvexError("Only a purchased batch can be sent for a decision.");
  }
  const approval = batch.approvalId ? await ctx.db.get("approvals", batch.approvalId) : null;
  if (approval?.status === "pending") {
    throw new ConvexError("A request for this batch is already waiting for a decision.");
  }
  return batch;
}

/** Sends a purchased batch to the Chief Admin (stock.approve) before shipping. */
export const submitForApproval = authedMutation({
  args: { batchId: v.id("stockBatches") },
  handler: async (ctx, { batchId }) => {
    const batch = await requirePurchasedWithoutPendingApproval(ctx, batchId);
    const approvalId = await requestApproval(ctx, {
      type: "stock_batch",
      businessUnitId: batch.businessUnitId,
      entityTable: "stockBatches",
      entityId: batch._id,
      payload: { kind: "approve", after: summary(batch, await batchItems(ctx, batch._id), await expensesOf(ctx, batch._id)) },
      reason: batch.description,
    });
    await ctx.db.patch("stockBatches", batch._id, { approvalId });
    return approvalId;
  },
});

/** Asks to unlock a purchased (not yet approved) batch back to draft, to fix it. */
export const requestReopen = authedMutation({
  args: { batchId: v.id("stockBatches"), reason: v.string() },
  handler: async (ctx, { batchId, reason }) => {
    const batch = await requirePurchasedWithoutPendingApproval(ctx, batchId);
    const cleanReason = cleanText(reason, 500, "Reason");
    if (!cleanReason) throw new ConvexError("A reason is required.");
    const approvalId = await requestApproval(ctx, {
      type: "stock_batch",
      businessUnitId: batch.businessUnitId,
      entityTable: "stockBatches",
      entityId: batch._id,
      payload: {
        kind: "reopen",
        before: { number: batch.number, status: "purchased" },
        after: { number: batch.number, status: "draft" },
      },
      reason: cleanReason,
    });
    await ctx.db.patch("stockBatches", batch._id, { approvalId });
    return approvalId;
  },
});

async function advance(
  ctx: AuthedMutationCtx,
  batch: Doc<"stockBatches">,
  from: Doc<"stockBatches">["status"],
  to: "shipped" | "arrived" | "received",
) {
  if (batch.status !== from) {
    throw new ConvexError(`Only a ${from} batch can be marked ${to}.`);
  }
  const stamp = { shipped: "shippedAt", arrived: "arrivedAt", received: "receivedAt" } as const;
  await ctx.db.patch("stockBatches", batch._id, { status: to, [stamp[to]]: Date.now() });
  await ctx.audit({
    action: "update",
    entityTable: "stockBatches",
    entityId: batch._id,
    businessUnitId: batch.businessUnitId,
    before: { number: batch.number, status: from },
    after: { number: batch.number, status: to },
  });
}

/** The buyer ships an approved batch. */
export const markShipped = authedMutation({
  args: { batchId: v.id("stockBatches") },
  handler: async (ctx, { batchId }) => {
    const batch = await requireOwnBatch(ctx, batchId, { draft: false });
    await advance(ctx, batch, "approved", "shipped");
  },
});

/** The Goma side (stock.receive) records arrival and receives the batch. */
async function requireReceiver(ctx: AuthedMutationCtx, batchId: Id<"stockBatches">) {
  await ctx.requirePermission("stock.receive");
  const batch = await ctx.db.get("stockBatches", batchId);
  if (!batch) throw new ConvexError("Batch not found.");
  return batch;
}

export const markArrived = authedMutation({
  args: { batchId: v.id("stockBatches") },
  handler: async (ctx, { batchId }) => {
    await advance(ctx, await requireReceiver(ctx, batchId), "shipped", "arrived");
  },
});

// ------------------------------------------------------------- receiving

/**
 * Records what actually arrived for one purchased line (autosaved while
 * the batch is "arrived"): good units, damaged units and, when any are
 * damaged or missing, why. Checked in full by confirmReceipt.
 */
export const setReceiveCount = authedMutation({
  args: {
    itemId: v.id("stockBatchItems"),
    qtyReceived: v.number(),
    qtyDamaged: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get("stockBatchItems", args.itemId);
    if (!item) throw new ConvexError("Line not found.");
    const batch = await requireReceiver(ctx, item.batchId);
    if (batch.status !== "arrived") {
      throw new ConvexError("Only an arrived batch can be counted.");
    }
    if (item.status !== "purchased") {
      throw new ConvexError("Only purchased lines are received.");
    }
    assertQty(args.qtyReceived, 0);
    assertQty(args.qtyDamaged, 0);
    if (args.qtyReceived + args.qtyDamaged > item.qtyPurchased) {
      throw new ConvexError(`Received and damaged can't exceed the ${item.qtyPurchased} purchased.`);
    }
    const next = {
      qtyReceived: args.qtyReceived,
      qtyDamaged: args.qtyDamaged,
      receiveReason: cleanText(args.reason, 500, "Reason"),
    };
    const changes = diff(
      { qtyReceived: item.qtyReceived ?? null, qtyDamaged: item.qtyDamaged ?? null, receiveReason: item.receiveReason ?? null },
      { ...next, receiveReason: next.receiveReason ?? null },
    );
    if (!changes) return;
    await ctx.db.patch("stockBatchItems", item._id, next);
    const product = await ctx.db.get("products", item.productId);
    await ctx.audit({
      action: "update",
      entityTable: "stockBatchItems",
      entityId: item._id,
      businessUnitId: batch.businessUnitId,
      before: { batch: batch.number, product: product?.name ?? null, ...changes.before },
      after: { batch: batch.number, product: product?.name ?? null, ...changes.after },
    });
  },
});

/**
 * Confirms the receipt: every purchased line must be counted (with a
 * reason for anything damaged or missing). Each line's good units become a
 * sellable lot (inventoryBatches, at the purchase unit cost) and enter the
 * business holder through applyMovement. The batch becomes "received".
 */
export const confirmReceipt = authedMutation({
  args: { batchId: v.id("stockBatches") },
  handler: async (ctx, { batchId }) => {
    const batch = await requireReceiver(ctx, batchId);
    if (batch.status !== "arrived") {
      throw new ConvexError("Only an arrived batch can be received.");
    }
    const items = await batchItems(ctx, batch._id);
    const incomplete = items
      .map((item) => ({ itemId: item._id, problems: receiveProblems(item) }))
      .filter((line) => line.problems.length > 0);
    if (incomplete.length > 0) {
      throw new ConvexError({ code: "INCOMPLETE" as const, lines: incomplete });
    }

    const business = await getOrCreateHolder(ctx, batch.businessUnitId, businessHolderRef(batch.businessUnitId));
    const now = Date.now();
    let received = 0;
    let damaged = 0;
    let missing = 0;
    for (const item of items) {
      if (item.status !== "purchased") continue;
      const qty = item.qtyReceived ?? 0;
      received += qty;
      damaged += item.qtyDamaged ?? 0;
      missing += missingQty(item);
      if (qty === 0) continue;
      const lot = {
        businessUnitId: batch.businessUnitId,
        productId: item.productId,
        sourceStockBatchItemId: item._id,
        stockBatchId: batch._id,
        unitCost: item.unitCost!,
        currency: "USD" as const,
        receivedQty: qty,
        createdAt: now,
      };
      const lotId = await ctx.db.insert("inventoryBatches", lot);
      const product = await ctx.db.get("products", item.productId);
      await ctx.audit({
        action: "create",
        entityTable: "inventoryBatches",
        entityId: lotId,
        businessUnitId: batch.businessUnitId,
        after: {
          batch: batch.number,
          product: product?.name ?? null,
          sku: product?.sku ?? null,
          unitCost: lot.unitCost,
          currency: "USD",
          receivedQty: qty,
        },
      });
      await applyMovement(ctx, {
        type: "receive",
        inventoryBatchId: lotId,
        toHolderId: business,
        qty,
        refTable: "stockBatches",
        refId: batch._id,
        actorId: ctx.user._id,
      });
    }
    await ctx.db.patch("stockBatches", batch._id, { status: "received", receivedAt: now, receivedBy: ctx.user._id });
    await ctx.audit({
      action: "update",
      entityTable: "stockBatches",
      entityId: batch._id,
      businessUnitId: batch.businessUnitId,
      before: { number: batch.number, status: "arrived" },
      after: { number: batch.number, status: "received", received, damaged, missing },
    });
  },
});
