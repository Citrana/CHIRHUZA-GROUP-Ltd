import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { diff } from "./lib/audit";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { nextSequenceNumber } from "./lib/requisitions";
import { activePeople, pickableLocations } from "./lib/locationScope";
import { businessHolderRef, findHolder, holderName, type HolderType } from "./lib/inventory";
import { describeProduct, PRODUCT_PROFILES } from "./lib/products";
import type { PermissionKey, Scope } from "./lib/permissions";
import {
  countReasonValidator,
  countScopeValidator,
  countStatusValidator,
  countTotals,
  DEFAULT_REMINDER_DAYS,
  expectedAtCount,
  lineDifference,
  MAX_COUNT_ITEMS,
  onHandNow,
  snapshotHolder,
} from "./lib/stockCounts";

/**
 * Stock counts (convex/lib/stockCounts.ts). stock.count.record starts a
 * count and enters what's really there (blind: expected quantities stay
 * hidden while counting); stock.count.review checks the differences, gives
 * each a reason and sends them for approval (one approval per line);
 * stock.count.approve holders decide in Approvals. All within location
 * scope: own_location = the caller's own location, or themselves.
 */

const COUNT_KEYS: PermissionKey[] = ["stock.count.record", "stock.count.review", "stock.count.approve", "stock.view"];

const holderArg = v.union(
  v.object({ type: v.literal("business") }),
  v.object({ type: v.literal("location"), id: v.id("locations") }),
  v.object({ type: v.literal("user"), id: v.id("users") }),
);

/** Whether a holder is within an own_location / all_locations scope for the caller. */
function holderInScope(scope: Scope, user: Doc<"users">, holder: Pick<Doc<"holders">, "type" | "refId">): boolean {
  if (scope === "all_locations") return true;
  if (holder.type === "location") return user.locationId !== undefined && holder.refId === user.locationId;
  if (holder.type === "user") return holder.refId === user._id;
  return false;
}

/** The broadest scope the caller has over stock counts, or null if none. */
function countScope(ctx: AuthedQueryCtx): Scope | null {
  const scopes = COUNT_KEYS.map((k) => ctx.permissions.get(k)).filter((s) => s !== undefined);
  if (scopes.length === 0) return null;
  return scopes.includes("all_locations") ? "all_locations" : "own_location";
}

/** A count the caller may see (any count permission or stock.view, in scope). */
async function requireVisibleCount(ctx: AuthedQueryCtx, countId: Id<"stockCounts">) {
  const scope = countScope(ctx);
  if (scope === null) await ctx.requirePermission("stock.view");
  const count = await ctx.db.get("stockCounts", countId);
  const holder = count ? await ctx.db.get("holders", count.holderId) : null;
  if (!count || !holder || !holderInScope(scope!, ctx.user, holder)) {
    throw new ConvexError("Stock count not found.");
  }
  return { count, holder };
}

/** Requires `key` for this count's holder. */
async function requireForCount(ctx: AuthedQueryCtx, key: PermissionKey, holder: Doc<"holders">) {
  await ctx.requirePermission(key, (scope, user) => holderInScope(scope, user, holder));
}

async function countItems(ctx: AuthedQueryCtx, countId: Id<"stockCounts">) {
  return await ctx.db
    .query("stockCountItems")
    .withIndex("by_stockCountId", (q) => q.eq("stockCountId", countId))
    .take(MAX_COUNT_ITEMS);
}

async function describeHolder(ctx: AuthedQueryCtx, holder: Doc<"holders">): Promise<{ type: HolderType; name: string }> {
  return { type: holder.type, name: await holderName(ctx, holder) };
}

/** What a new count can be about: the holders the caller may count, and the service's categories. */
export const options = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("stock.count.record");
    await requireBusinessUnit(ctx, businessUnitKey);
    const { locked, locations } = await pickableLocations(ctx, scope);
    const people = locked
      ? [{ _id: ctx.user._id, name: ctx.user.name || ctx.user.email, email: ctx.user.email }]
      : await activePeople(ctx);
    return {
      canCountBusiness: !locked,
      locations: locations.map((l) => ({ _id: l._id, name: l.name, type: l.type })),
      people,
      categories: PRODUCT_PROFILES[businessUnitKey].categories,
    };
  },
});

/**
 * Starts a count: freezes the expected quantity of each product the holder
 * has now (all, one category, or a random sample). One open count per holder.
 */
export const start = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, holder: holderArg, scope: countScopeValidator },
  handler: async (ctx, args) => {
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const ref =
      args.holder.type === "business"
        ? businessHolderRef(unit._id)
        : args.holder.type === "location"
          ? { type: "location" as const, refId: args.holder.id }
          : { type: "user" as const, refId: args.holder.id };
    await ctx.requirePermission("stock.count.record", (scope, user) => holderInScope(scope, user, ref));
    if (args.holder.type === "location") {
      const location = await ctx.db.get("locations", args.holder.id);
      if (!location?.active) throw new ConvexError("Choose an active location.");
    }
    if (args.scope.kind === "category" && !PRODUCT_PROFILES[args.businessUnitKey].categories.includes(args.scope.category)) {
      throw new ConvexError("Choose a category of this service.");
    }

    const holder = await findHolder(ctx, unit._id, ref);
    if (!holder) throw new ConvexError({ code: "NOTHING_TO_COUNT" as const, message: "Nothing is held here yet." });
    for (const status of ["counting", "review"] as const) {
      const open = await ctx.db
        .query("stockCounts")
        .withIndex("by_holderId_and_status", (q) => q.eq("holderId", holder._id).eq("status", status))
        .first();
      if (open) {
        throw new ConvexError({ code: "COUNT_OPEN" as const, message: `${open.number} is still open here.`, countId: open._id });
      }
    }

    let lines = await snapshotHolder(ctx, holder._id);
    const scope = args.scope;
    if (scope.kind === "category") {
      const kept = [];
      for (const line of lines) {
        if ((await ctx.db.get("products", line.productId))?.category === scope.category) kept.push(line);
      }
      lines = kept;
    } else if (scope.kind === "sample") {
      if (!Number.isSafeInteger(scope.size) || scope.size < 1) {
        throw new ConvexError("The number of products must be a whole number from 1.");
      }
      // Fisher-Yates, then the first N.
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      lines = lines.slice(0, scope.size);
    }
    if (lines.length === 0) throw new ConvexError({ code: "NOTHING_TO_COUNT" as const, message: "No products to count here." });
    if (lines.length > MAX_COUNT_ITEMS) {
      throw new ConvexError(`Too many products (${lines.length}); count one category at a time.`);
    }

    const snapshotAt = Date.now();
    const number = await nextSequenceNumber(ctx, unit._id, "stockCount", "CNT");
    const countId = await ctx.db.insert("stockCounts", {
      businessUnitId: unit._id,
      number,
      holderId: holder._id,
      ...(ref.type === "location" ? { locationId: ref.refId } : {}),
      scope,
      status: "counting",
      snapshotAt,
      startedBy: ctx.user._id,
      itemCount: lines.length,
      countedCount: 0,
      diffCount: 0,
      lostCost: 0,
      gainedCost: 0,
      currency: "USD",
    });
    for (const line of lines) {
      await ctx.db.insert("stockCountItems", { stockCountId: countId, businessUnitId: unit._id, movedSinceSnapshot: 0, ...line });
    }
    await ctx.audit({
      action: "create",
      entityTable: "stockCounts",
      entityId: countId,
      businessUnitId: unit._id,
      after: {
        number,
        holder: await holderName(ctx, holder),
        scope: scope.kind === "category" ? scope.category : scope.kind === "sample" ? `sample of ${scope.size}` : "all",
        products: lines.length,
        expectedUnits: lines.reduce((t, l) => t + l.expectedQty, 0),
        status: "counting",
      },
    });
    return countId;
  },
});

/**
 * Saves one product's counted quantity (autosave). Records what moved in or
 * out since the snapshot until now, so sales during the count aren't losses.
 * Saving the same number again refreshes that (e.g. after a late sale).
 */
export const saveCount = authedMutation({
  args: { itemId: v.id("stockCountItems"), countedQty: v.number() },
  handler: async (ctx, { itemId, countedQty }) => {
    const item = await ctx.db.get("stockCountItems", itemId);
    if (!item) throw new ConvexError("Line not found.");
    const { count, holder } = await requireVisibleCount(ctx, item.stockCountId);
    await requireForCount(ctx, count.status === "review" && ctx.can("stock.count.review") ? "stock.count.review" : "stock.count.record", holder);
    if (count.status !== "counting" && count.status !== "review") {
      throw new ConvexError("This count can no longer be changed.");
    }
    if (!Number.isSafeInteger(countedQty) || countedQty < 0) {
      throw new ConvexError("Counts must be whole numbers from 0.");
    }
    const movedSinceSnapshot = (await onHandNow(ctx, count.holderId, item.productId)) - item.expectedQty;
    await ctx.db.patch("stockCountItems", itemId, {
      countedQty,
      countedAt: Date.now(),
      countedBy: ctx.user._id,
      movedSinceSnapshot,
    });
    if (item.countedQty === undefined) {
      await ctx.db.patch("stockCounts", count._id, { countedCount: count.countedCount + 1 });
    }
    const product = await describeProduct(ctx, item.productId);
    const changes = diff(
      { countedQty: item.countedQty, movedSinceSnapshot: item.movedSinceSnapshot },
      { countedQty, movedSinceSnapshot },
    );
    if (changes) {
      await ctx.audit({
        action: "update",
        entityTable: "stockCountItems",
        entityId: itemId,
        businessUnitId: count.businessUnitId,
        before: { count: count.number, product: product.productName, sku: product.sku, ...changes.before },
        after: { count: count.number, product: product.productName, sku: product.sku, ...changes.after },
      });
    }
  },
});

/** Clears a line's count so it is counted again. */
export const recount = authedMutation({
  args: { itemId: v.id("stockCountItems") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get("stockCountItems", itemId);
    if (!item) throw new ConvexError("Line not found.");
    const { count, holder } = await requireVisibleCount(ctx, item.stockCountId);
    await requireForCount(ctx, "stock.count.review", holder);
    if (count.status !== "review") throw new ConvexError("Only a count being reviewed can be recounted.");
    if (item.countedQty === undefined) return;
    await ctx.db.patch("stockCountItems", itemId, {
      countedQty: undefined,
      countedAt: undefined,
      countedBy: undefined,
      movedSinceSnapshot: 0,
      reason: undefined,
      note: undefined,
    });
    await ctx.db.patch("stockCounts", count._id, { countedCount: count.countedCount - 1 });
    const product = await describeProduct(ctx, item.productId);
    await ctx.audit({
      action: "update",
      entityTable: "stockCountItems",
      entityId: itemId,
      businessUnitId: count.businessUnitId,
      before: { count: count.number, product: product.productName, countedQty: item.countedQty },
      after: { count: count.number, product: product.productName, countedQty: null, recount: true },
    });
  },
});

/** Ends counting: the count moves to review (lines left blank are not counted). */
export const finishCounting = authedMutation({
  args: { countId: v.id("stockCounts") },
  handler: async (ctx, { countId }) => {
    const { count, holder } = await requireVisibleCount(ctx, countId);
    await requireForCount(ctx, "stock.count.record", holder);
    if (count.status !== "counting") throw new ConvexError("This count is not being counted.");
    if (count.countedCount === 0) throw new ConvexError({ code: "NOTHING_COUNTED" as const, message: "Count at least one product first." });
    await ctx.db.patch("stockCounts", countId, { status: "review" });
    await ctx.audit({
      action: "update",
      entityTable: "stockCounts",
      entityId: countId,
      businessUnitId: count.businessUnitId,
      before: { number: count.number, status: "counting" },
      after: { number: count.number, status: "review" },
    });
  },
});

/** Why a counted line differs from the system. */
export const setReason = authedMutation({
  args: { itemId: v.id("stockCountItems"), reason: countReasonValidator, note: v.optional(v.string()) },
  handler: async (ctx, { itemId, reason, note }) => {
    const item = await ctx.db.get("stockCountItems", itemId);
    if (!item) throw new ConvexError("Line not found.");
    const { count, holder } = await requireVisibleCount(ctx, item.stockCountId);
    await requireForCount(ctx, "stock.count.review", holder);
    if (count.status !== "review") throw new ConvexError("This count is not being reviewed.");
    const trimmed = note?.trim() || undefined;
    if (trimmed && trimmed.length > 500) throw new ConvexError("Note is too long.");
    await ctx.db.patch("stockCountItems", itemId, { reason, note: trimmed });
    const changes = diff({ reason: item.reason, note: item.note }, { reason, note: trimmed });
    if (changes) {
      const product = await describeProduct(ctx, item.productId);
      await ctx.audit({
        action: "update",
        entityTable: "stockCountItems",
        entityId: itemId,
        businessUnitId: count.businessUnitId,
        before: { count: count.number, product: product.productName, ...changes.before },
        after: { count: count.number, product: product.productName, ...changes.after },
      });
    }
  },
});

/**
 * Sends each counted line that differs for approval, one request per line
 * (lines that match need none). Every difference needs a reason. Stock
 * changes only when each request is approved.
 */
export const submit = authedMutation({
  args: { countId: v.id("stockCounts") },
  handler: async (ctx, { countId }) => {
    const { count, holder } = await requireVisibleCount(ctx, countId);
    await requireForCount(ctx, "stock.count.review", holder);
    if (count.status !== "review") throw new ConvexError("This count is not being reviewed.");
    const items = await countItems(ctx, countId);
    const counted = items.filter((i) => i.countedQty !== undefined);
    if (counted.length === 0) throw new ConvexError({ code: "NOTHING_COUNTED" as const, message: "Nothing was counted." });
    const differing = counted.filter((i) => lineDifference(i) !== 0);
    const missingReason = differing.filter((i) => !i.reason).map((i) => i._id);
    if (missingReason.length > 0) {
      throw new ConvexError({
        code: "MISSING_REASONS" as const,
        message: "Give a reason for every difference.",
        itemIds: missingReason,
      });
    }

    const holderLabel = await holderName(ctx, holder);
    for (const item of differing) {
      const qty = lineDifference(item)!;
      const cost = Math.abs(qty) * item.unitCost;
      const adjustmentId = await ctx.db.insert("stockAdjustments", {
        businessUnitId: count.businessUnitId,
        stockCountId: countId,
        stockCountItemId: item._id,
        holderId: holder._id,
        productId: item.productId,
        qty,
        cost,
        currency: "USD",
        reason: item.reason!,
        ...(item.note ? { note: item.note } : {}),
        status: "pending",
        requestedBy: ctx.user._id,
        countedBy: item.countedBy!,
      });
      const product = await describeProduct(ctx, item.productId);
      const summary = {
        number: count.number,
        holder: holderLabel,
        product: product.productName,
        lengthInches: product.lengthInches,
        size: product.sizeName,
        colour: product.colourName,
        sku: product.sku,
        expected: expectedAtCount(item),
        counted: item.countedQty!,
        difference: qty,
        countReason: item.reason!,
        differenceCost: cost,
        currency: "USD" as const,
      };
      const approvalId = await requestApproval(ctx, {
        type: "stock_adjustment",
        businessUnitId: count.businessUnitId,
        ...(count.locationId ? { locationId: count.locationId } : {}),
        entityTable: "stockAdjustments",
        entityId: adjustmentId,
        payload: { after: summary },
        ...(item.note ? { reason: item.note } : {}),
      });
      await ctx.db.patch("stockAdjustments", adjustmentId, { approvalId });
      await ctx.db.patch("stockCountItems", item._id, { adjustmentId });
      await ctx.audit({
        action: "create",
        entityTable: "stockAdjustments",
        entityId: adjustmentId,
        businessUnitId: count.businessUnitId,
        after: { ...summary, status: "pending", note: item.note ?? null },
      });
    }

    const totals = countTotals(counted);
    const now = Date.now();
    const status = differing.length === 0 ? "done" : "submitted";
    await ctx.db.patch("stockCounts", countId, {
      status,
      submittedBy: ctx.user._id,
      submittedAt: now,
      ...(status === "done" ? { completedAt: now } : {}),
      ...totals,
    });
    await ctx.audit({
      action: "update",
      entityTable: "stockCounts",
      entityId: countId,
      businessUnitId: count.businessUnitId,
      before: { number: count.number, status: "review" },
      after: { number: count.number, status, ...totals, currency: "USD" },
    });
    return { differences: differing.length };
  },
});

/** Stops a count before it is sent: nothing changes in stock. */
export const cancel = authedMutation({
  args: { countId: v.id("stockCounts") },
  handler: async (ctx, { countId }) => {
    const { count, holder } = await requireVisibleCount(ctx, countId);
    await requireForCount(ctx, "stock.count.review", holder);
    if (count.status !== "counting" && count.status !== "review") {
      throw new ConvexError("Only an open count can be cancelled.");
    }
    await ctx.db.patch("stockCounts", countId, { status: "cancelled", cancelledBy: ctx.user._id });
    await ctx.audit({
      action: "update",
      entityTable: "stockCounts",
      entityId: countId,
      businessUnitId: count.businessUnitId,
      before: { number: count.number, status: count.status },
      after: { number: count.number, status: "cancelled" },
    });
  },
});

/** Past and open counts, newest first (own_location: own location and own counts as a holder). */
export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    status: v.optional(countStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { businessUnitKey, status, paginationOpts }) => {
    const scope = countScope(ctx);
    if (scope === null) await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const result = status
      ? await ctx.db
          .query("stockCounts")
          .withIndex("by_businessUnitId_and_status", (q) => q.eq("businessUnitId", unit._id).eq("status", status))
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("stockCounts")
          .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
          .order("desc")
          .paginate(paginationOpts);
    const page = [];
    for (const count of result.page) {
      const holder = await ctx.db.get("holders", count.holderId);
      if (!holder || !holderInScope(scope!, ctx.user, holder)) continue;
      const starter = await ctx.db.get("users", count.startedBy);
      page.push({
        ...count,
        holder: await describeHolder(ctx, holder),
        startedByName: starter?.name || starter?.email || null,
      });
    }
    return { ...result, page };
  },
});

/**
 * One count with its lines. Expected quantities stay hidden while counting
 * (blind), unless an approver asks to see them.
 */
export const get = authedQuery({
  args: { countId: v.string(), showExpected: v.optional(v.boolean()) },
  handler: async (ctx, { countId: rawId, showExpected }) => {
    const scope = countScope(ctx);
    if (scope === null) await ctx.requirePermission("stock.view");
    const countId = ctx.db.normalizeId("stockCounts", rawId);
    const count = countId ? await ctx.db.get("stockCounts", countId) : null;
    const holder = count ? await ctx.db.get("holders", count.holderId) : null;
    if (!count || !holder || !holderInScope(scope!, ctx.user, holder)) return null;
    const unit = await ctx.db.get("businessUnits", count.businessUnitId);
    const inScope = (key: PermissionKey) => {
      const scope = ctx.permissions.get(key);
      return scope !== undefined && holderInScope(scope, ctx.user, holder);
    };
    const canApprove = inScope("stock.count.approve");
    const blind = count.status === "counting" && !(showExpected && canApprove);

    const items = await countItems(ctx, count._id);
    const lines = await Promise.all(
      items.map(async (item) => {
        const adjustment = item.adjustmentId ? await ctx.db.get("stockAdjustments", item.adjustmentId) : null;
        const counter = item.countedBy ? await ctx.db.get("users", item.countedBy) : null;
        const difference = lineDifference(item);
        return {
          _id: item._id,
          productId: item.productId,
          ...(await describeProduct(ctx, item.productId)),
          countedQty: item.countedQty ?? null,
          countedByName: counter?.name || counter?.email || null,
          reason: item.reason ?? null,
          note: item.note ?? null,
          adjustmentStatus: adjustment?.status ?? null,
          ...(blind
            ? { expectedQty: null, movedSinceSnapshot: null, difference: null, differenceCost: null }
            : {
                expectedQty: item.expectedQty,
                movedSinceSnapshot: item.movedSinceSnapshot,
                difference,
                differenceCost: difference === null ? null : difference * item.unitCost,
              }),
        };
      }),
    );
    lines.sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? ""));
    const people = async (id: Id<"users"> | undefined) => {
      const user = id ? await ctx.db.get("users", id) : null;
      return user?.name || user?.email || null;
    };
    return {
      ...count,
      businessUnitKey: unit?.key ?? null,
      holder: await describeHolder(ctx, holder),
      startedByName: await people(count.startedBy),
      submittedByName: await people(count.submittedBy),
      blind,
      lines,
      totals: blind ? null : countTotals(items),
      can: {
        record: inScope("stock.count.record"),
        review: inScope("stock.count.review"),
        approve: canApprove,
      },
    };
  },
});

async function settingsRow(ctx: AuthedQueryCtx, businessUnitId: Id<"businessUnits">) {
  return await ctx.db
    .query("stockCountSettings")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", businessUnitId))
    .unique();
}

export const settings = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    if (countScope(ctx) === null) await ctx.requirePermission("stock.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    return { reminderDays: (await settingsRow(ctx, unit._id))?.reminderDays ?? DEFAULT_REMINDER_DAYS };
  },
});

/** How many days without a finished count before Home reminds (approvers only). */
export const setSettings = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, reminderDays: v.number() },
  handler: async (ctx, { businessUnitKey, reminderDays }) => {
    await ctx.requirePermission("stock.count.approve", (scope) => scope === "all_locations");
    if (!Number.isSafeInteger(reminderDays) || reminderDays < 1 || reminderDays > 365) {
      throw new ConvexError("Choose a number of days from 1 to 365.");
    }
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const row = await settingsRow(ctx, unit._id);
    if (row) {
      if (row.reminderDays === reminderDays) return;
      await ctx.db.patch("stockCountSettings", row._id, { reminderDays });
      await ctx.audit({
        action: "update",
        entityTable: "stockCountSettings",
        entityId: row._id,
        businessUnitId: unit._id,
        before: { reminderDays: row.reminderDays },
        after: { reminderDays },
      });
    } else {
      const id = await ctx.db.insert("stockCountSettings", { businessUnitId: unit._id, reminderDays });
      await ctx.audit({
        action: "create",
        entityTable: "stockCountSettings",
        entityId: id,
        businessUnitId: unit._id,
        after: { reminderDays },
      });
    }
  },
});
