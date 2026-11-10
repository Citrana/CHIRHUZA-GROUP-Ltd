import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { nextSequenceNumber } from "./lib/requisitions";
import { applyMovement, findHolder, getOrCreateHolder, stockLevelOf } from "./lib/inventory";
import { filterableLocations, inScope, pickableLocations } from "./lib/locationScope";
import { requestApproval } from "./lib/approvals";
import { planSaleEdit, saleEditChangesValidator, saleItemsOf } from "./lib/saleEdits";
import { applyRollupEvents, saleEvents, unitsSoldOn } from "./lib/analytics";
import { businessDayEndUtc, businessDayOf, businessDayStartUtc } from "./lib/time";
import {
  MAX_BACKDATE_DAYS,
  MAX_SALE_LINES,
  lineMargin,
  paymentMethodValidator,
  saleLineProblems,
  saleTimestamp,
} from "./lib/sales";
import { describeProduct } from "./lib/products";
import { pendingSaleApprovals } from "./lib/sales";
import {
  applyExchange,
  exchangeRefusal,
  planExchange,
  returnedSoFar,
  saleExchangeChangesValidator,
} from "./lib/exchanges";
import {
  applySalePayment,
  collectionMethodValidator,
  creditStatusValidator,
  saleBalance,
  splitDiscount,
} from "./lib/credit";

/**
 * Sales (convex/lib/sales.ts). sales.create records a sale; its scope is
 * the location lock: own_location sells only at the seller's own location,
 * all_locations anywhere (Chief Sales Admin, Super Admin). sales.view lists
 * them, own_location viewers seeing only their location.
 */

/**
 * Every lot in stock at a location for a service, with its product, source
 * batch, date, cost, suggested price and quantity on hand (by product name,
 * oldest lot first): what a sale or an exchange can give out there.
 */
async function lotsAt(ctx: QueryCtx, businessUnitId: Id<"businessUnits">, locationId: Id<"locations">) {
  const lots = [];
  const holder = await findHolder(ctx, businessUnitId, { type: "location", refId: locationId });
  if (holder) {
    const levels = await ctx.db
      .query("stockLevels")
      .withIndex("by_holderId", (q) => q.eq("holderId", holder._id))
      .take(2000);
    for (const level of levels) {
      if (level.qtyOnHand <= 0) continue;
      const lot = await ctx.db.get("inventoryBatches", level.inventoryBatchId);
      if (!lot) continue;
      const product = await ctx.db.get("products", lot.productId);
      const batch = await ctx.db.get("stockBatches", lot.stockBatchId);
      lots.push({
        _id: lot._id,
        productId: lot.productId,
        ...(await describeProduct(ctx, lot.productId)),
        suggestedPrice: product?.suggestedPrice ?? null,
        photoUrl: product?.photoFileId ? await ctx.storage.getUrl(product.photoFileId) : null,
        batchNumber: batch?.number ?? null,
        lotDate: lot.createdAt,
        unitCost: lot.unitCost,
        onHand: level.qtyOnHand,
      });
    }
  }
  lots.sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? "") || a.lotDate - b.lotDate);
  return lots;
}

/**
 * What the sale form needs: where the caller may sell (locked to their own
 * location for own_location sellers) and, for the chosen location, every
 * lot in stock there with its product, source batch, date, cost, suggested
 * price and quantity on hand (oldest lot first per product).
 */
export const options = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator, locationId: v.optional(v.id("locations")) },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("sales.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    // Locations are shared by every service; own_location: just theirs.
    const { locations } = await pickableLocations(ctx, scope);
    const location =
      scope === "own_location"
        ? (locations[0] ?? null)
        : (locations.find((l) => l._id === args.locationId) ?? null);

    const lots = location ? await lotsAt(ctx, unit._id, location._id) : [];
    return {
      locations: locations.map((l) => ({ _id: l._id, name: l.name })),
      locationLocked: scope === "own_location",
      locationId: location?._id ?? null,
      lots,
    };
  },
});

export const create = authedMutation({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    locationId: v.optional(v.id("locations")),
    // The business day it was sold (YYYY-MM-DD); missing = today. Up to
    // MAX_BACKDATE_DAYS back, for sales recorded late.
    soldOn: v.optional(v.string()),
    paymentMethod: paymentMethodValidator,
    // Optional for cash / mobile money sales (credit sales use customerId).
    customerName: v.optional(v.string()),
    // Credit sales: the customer (customers.create adds a new one), what
    // they paid now (cents, 0 or more) and how.
    customerId: v.optional(v.id("customers")),
    paidNow: v.optional(v.number()),
    paidNowMethod: v.optional(collectionMethodValidator),
    // The total the customer agreed to pay (cents); missing = the lines'
    // sum. Lower than that is a whole-sale discount and needs a reason.
    agreedTotal: v.optional(v.number()),
    saleDiscountReason: v.optional(v.string()),
    lines: v.array(
      v.object({
        inventoryBatchId: v.id("inventoryBatches"),
        qty: v.number(),
        unitPrice: v.number(),
        discountReason: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("sales.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);

    // 1. Where: own_location sellers are locked to their own location.
    let location: Doc<"locations"> | null;
    if (scope === "own_location") {
      if (!ctx.user.locationId) throw new ConvexError("You have no location to sell at.");
      if (args.locationId && args.locationId !== ctx.user.locationId) {
        throw new ConvexError("You can only sell at your own location.");
      }
      location = await ctx.db.get("locations", ctx.user.locationId);
    } else {
      if (!args.locationId) throw new ConvexError("Choose the location of the sale.");
      location = await ctx.db.get("locations", args.locationId);
    }
    if (!location || !location.active) {
      throw new ConvexError("Choose an active location.");
    }

    // When: today, or an earlier day for a sale recorded late.
    const recordedAt = Date.now();
    const when = saleTimestamp(args.soldOn, recordedAt);
    if ("problem" in when) {
      throw new ConvexError(
        when.problem === "future"
          ? "A sale can't be dated in the future."
          : when.problem === "tooOld"
            ? `Pick today or one of the last ${MAX_BACKDATE_DAYS} days.`
            : "The sale date must be YYYY-MM-DD.",
      );
    }

    // 2. What: validate every line before writing anything.
    if (args.lines.length === 0) throw new ConvexError("Add at least one line.");
    if (args.lines.length > MAX_SALE_LINES) throw new ConvexError(`At most ${MAX_SALE_LINES} lines.`);
    if (new Set(args.lines.map((l) => l.inventoryBatchId)).size !== args.lines.length) {
      throw new ConvexError("Each lot can appear only once.");
    }
    const isCredit = args.paymentMethod === "credit";
    const customer = isCredit && args.customerId ? await ctx.db.get("customers", args.customerId) : null;
    if (isCredit && (!customer || customer.businessUnitId !== unit._id)) {
      throw new ConvexError("A credit sale needs the customer.");
    }
    if (!isCredit && (args.customerId || args.paidNow !== undefined)) {
      throw new ConvexError("Only a credit sale has a customer and a part payment.");
    }
    const customerName = customer ? customer.name : args.customerName?.trim() || undefined;
    if (customerName && customerName.length > 120) throw new ConvexError("Customer name is too long.");

    const lines = [];
    for (const line of args.lines) {
      const lot = await ctx.db.get("inventoryBatches", line.inventoryBatchId);
      if (!lot || lot.businessUnitId !== unit._id) throw new ConvexError("Stock lot not found.");
      const product = await ctx.db.get("products", lot.productId);
      const described = await describeProduct(ctx, lot.productId);
      const problems = saleLineProblems(line, product?.suggestedPrice);
      if (problems.includes("qty")) throw new ConvexError("Quantities must be whole numbers from 1.");
      if (problems.includes("price")) throw new ConvexError("Prices must be whole cents from 0.");
      if (problems.includes("discountReason")) {
        throw new ConvexError({
          code: "DISCOUNT_REASON" as const,
          message: `${described.productName ?? "A product"} is sold at another price than suggested: give a reason.`,
          inventoryBatchId: lot._id,
        });
      }
      const discountReason = line.discountReason?.trim() || undefined;
      if (discountReason && discountReason.length > 300) throw new ConvexError("Discount reason is too long.");
      const batch = await ctx.db.get("stockBatches", lot.stockBatchId);
      lines.push({ line, lot, product, described, discountReason, batchNumber: batch?.number ?? null });
    }

    // The agreed total: the lines' sum, or less (a whole-sale discount,
    // with a reason), split over the lines for per-product revenue.
    const linesTotal = lines.reduce((s, l) => s + l.line.unitPrice * l.line.qty, 0);
    const totalAmount = args.agreedTotal ?? linesTotal;
    if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) throw new ConvexError("The total must be whole cents from 0.");
    if (totalAmount > linesTotal) throw new ConvexError("The total to pay can't be more than the lines' total.");
    const saleDiscountReason = totalAmount < linesTotal ? args.saleDiscountReason?.trim() || undefined : undefined;
    if (totalAmount < linesTotal && !saleDiscountReason) {
      throw new ConvexError({ code: "SALE_DISCOUNT_REASON" as const, message: "Say why the total is lower than the lines' total." });
    }
    if (saleDiscountReason && saleDiscountReason.length > 300) throw new ConvexError("The discount reason is too long.");
    const shares = splitDiscount(
      lines.map((l) => l.line.unitPrice * l.line.qty),
      linesTotal - totalAmount,
    );

    // Credit: what the customer paid now (0 up to the total), and how.
    const paidNow = isCredit ? (args.paidNow ?? 0) : 0;
    if (!Number.isSafeInteger(paidNow) || paidNow < 0 || paidNow > totalAmount) {
      throw new ConvexError("What was paid now must be from 0 up to the total.");
    }
    if (paidNow > 0 && !args.paidNowMethod) throw new ConvexError("Say how the customer paid now.");

    // 3. Record the sale with each line's cost snapshot.
    const totalCost = lines.reduce((s, l) => s + l.lot.unitCost * l.line.qty, 0);
    const number = await nextSequenceNumber(ctx, unit._id, "sale", "SALE");
    const createdAt = when.createdAt;
    const saleId = await ctx.db.insert("sales", {
      businessUnitId: unit._id,
      number,
      locationId: location._id,
      soldBy: ctx.user._id,
      ...(customer ? { customerId: customer._id } : {}),
      ...(customerName ? { customerName } : {}),
      paymentMethod: args.paymentMethod,
      currency: "USD",
      totalAmount,
      linesTotal,
      ...(saleDiscountReason ? { saleDiscountReason } : {}),
      ...(customer ? { amountPaid: 0, creditStatus: totalAmount > 0 ? ("open" as const) : ("settled" as const) } : {}),
      totalCost,
      status: "completed",
      createdAt,
      recordedAt,
    });

    // 4. Take the stock out of the location, through the one inventory
    // function: it refuses to go below zero, and then nothing above is kept
    // (the mutation is one transaction). Concurrent sales of the last unit
    // are serialized by Convex: the loser re-runs, sees 0 and fails here.
    const from = await getOrCreateHolder(ctx, unit._id, { type: "location", refId: location._id });
    for (const [i, { line, lot, product, discountReason }] of lines.entries()) {
      await ctx.db.insert("saleItems", {
        saleId,
        productId: lot.productId,
        inventoryBatchId: lot._id,
        qty: line.qty,
        unitPrice: line.unitPrice,
        unitCostSnapshot: lot.unitCost,
        ...(product?.suggestedPrice !== undefined ? { suggestedPriceSnapshot: product.suggestedPrice } : {}),
        currency: "USD",
        ...(discountReason ? { discountReason } : {}),
        ...(shares[i] > 0 ? { saleDiscountShare: shares[i] } : {}),
      });
      try {
        await applyMovement(ctx, {
          type: "sale",
          inventoryBatchId: lot._id,
          fromHolderId: from,
          qty: line.qty,
          refTable: "sales",
          refId: saleId,
          actorId: ctx.user._id,
        });
      } catch (e) {
        const data = e instanceof ConvexError ? (e.data as { code?: string; onHand?: number }) : null;
        if (data?.code === "INSUFFICIENT_STOCK") {
          throw new ConvexError({
            code: "INSUFFICIENT_STOCK" as const,
            message: `Only ${data.onHand ?? 0} left of ${product?.name ?? "this product"} at ${location.name}.`,
            inventoryBatchId: lot._id,
            onHand: data.onHand ?? 0,
          });
        }
        throw e;
      }
    }

    // Analytics rollups, in the same mutation (never scan raw sales).
    await applyRollupEvents(
      ctx,
      unit._id,
      saleEvents(
        { locationId: location._id, createdAt, paymentMethod: args.paymentMethod },
        lines.map(({ line, lot }, i) => ({
          productId: lot.productId,
          qty: line.qty,
          unitPrice: line.unitPrice,
          unitCostSnapshot: lot.unitCost,
          saleDiscountShare: shares[i],
        })),
      ),
    );

    await ctx.audit({
      action: "create",
      entityTable: "sales",
      entityId: saleId,
      businessUnitId: unit._id,
      after: {
        number,
        soldOn: businessDayOf(createdAt),
        ...(when.backdated ? { backdated: true, recordedOn: businessDayOf(recordedAt) } : {}),
        location: location.name,
        paymentMethod: args.paymentMethod,
        customerName: customerName ?? null,
        items: lines.map(({ line, described, batchNumber, discountReason }) => ({
          product: described.productName ?? "—",
          lengthInches: described.lengthInches,
          size: described.sizeName,
          colour: described.colourName,
          sku: described.sku,
          batch: batchNumber,
          qty: line.qty,
          unitPrice: line.unitPrice,
          discountReason: discountReason ?? null,
        })),
        linesTotal,
        totalAmount,
        saleDiscountReason: saleDiscountReason ?? null,
        currency: "USD",
        status: "completed",
      },
    });

    // Credit: the customer now owes the total, less what they paid now.
    if (customer) {
      await ctx.db.patch("customers", customer._id, { balance: customer.balance + totalAmount });
      await ctx.audit({
        action: "update",
        entityTable: "customers",
        entityId: customer._id,
        businessUnitId: unit._id,
        before: { name: customer.name, balanceAmount: customer.balance, currency: "USD" },
        after: { name: customer.name, balanceAmount: customer.balance + totalAmount, currency: "USD", sale: number },
      });
      if (paidNow > 0) {
        await applySalePayment(ctx, {
          sale: (await ctx.db.get("sales", saleId))!,
          amount: paidNow,
          method: args.paidNowMethod!,
          kind: "at_sale",
          paidAt: createdAt,
          actorId: ctx.user._id,
        });
      }
    }
    const soldOn = businessDayOf(createdAt);
    return {
      saleId,
      number,
      soldOn,
      recordedOn: businessDayOf(recordedAt),
      // Products the shop sold that day, this sale included (for the seller's encouragement card).
      dayUnits: await unitsSoldOn(ctx, unit._id, location._id, soldOn),
    };
  },
});

function dayRange(from: string | undefined, to: string | undefined) {
  try {
    return {
      start: from ? businessDayStartUtc(from) : undefined,
      end: to ? businessDayEndUtc(to) : undefined,
    };
  } catch {
    throw new ConvexError("Dates must be YYYY-MM-DD.");
  }
}

/**
 * Sales, newest first, with their lines and margins. Filters: location,
 * business days (Lubumbashi time) and credit status (open = still owes,
 * settled = paid in full; other sales are left out). own_location viewers
 * only ever see their own location's sales. The credit filter runs after the
 * index range, so a page can hold fewer rows than asked while more remain.
 */
export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    locationId: v.optional(v.id("locations")),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    creditStatus: v.optional(creditStatusValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("sales.view");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const locationId = scope === "own_location" ? ctx.user.locationId : args.locationId;
    if (scope === "own_location" && !locationId) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (locationId) {
      const location = await ctx.db.get("locations", locationId);
      if (!location) {
        return { page: [], isDone: true, continueCursor: "" };
      }
    }
    const { start, end } = dayRange(args.from, args.to);

    const ordered = locationId
      ? ctx.db
          .query("sales")
          .withIndex("by_locationId_and_createdAt", (q) => {
            const eq = q.eq("locationId", locationId);
            const lower = start !== undefined ? eq.gte("createdAt", start) : eq;
            return end !== undefined ? lower.lte("createdAt", end) : lower;
          })
          .order("desc")
      : ctx.db
          .query("sales")
          .withIndex("by_businessUnitId_and_createdAt", (q) => {
            const eq = q.eq("businessUnitId", unit._id);
            const lower = start !== undefined ? eq.gte("createdAt", start) : eq;
            return end !== undefined ? lower.lte("createdAt", end) : lower;
          })
          .order("desc");
    const { creditStatus } = args;
    const result = await (
      creditStatus ? ordered.filter((q) => q.eq(q.field("creditStatus"), creditStatus)) : ordered
    ).paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map(async (sale) => {
        const [location, seller, items] = await Promise.all([
          ctx.db.get("locations", sale.locationId),
          ctx.db.get("users", sale.soldBy),
          ctx.db
            .query("saleItems")
            .withIndex("by_saleId", (q) => q.eq("saleId", sale._id))
            .take(MAX_SALE_LINES),
        ]);
        const lines = await Promise.all(
          items.map(async (item) => {
            const lot = await ctx.db.get("inventoryBatches", item.inventoryBatchId);
            const batch = lot ? await ctx.db.get("stockBatches", lot.stockBatchId) : null;
            return {
              ...item,
              ...(await describeProduct(ctx, item.productId)),
              batchNumber: batch?.number ?? null,
              margin: lineMargin(item),
            };
          }),
        );
        // Credit sales: what's still owed, and every payment so far.
        const payments = sale.creditStatus
          ? (
              await ctx.db
                .query("salePayments")
                .withIndex("by_saleId", (q) => q.eq("saleId", sale._id))
                .take(100)
            ).map((p) => ({ _id: p._id, amount: p.amount, method: p.method, kind: p.kind, paidAt: p.paidAt }))
          : [];
        const pending = await pendingSaleApprovals(ctx, sale._id);
        const exchanges = await exchangesOf(ctx, sale._id);
        return {
          ...sale,
          pendingEdit: pending.has("sale_edit"),
          pendingExchange: pending.has("sale_exchange"),
          exchanges,
          // Whether products can be brought back now (the Exchange button).
          exchangeable:
            exchangeRefusal(sale, Date.now()) === null &&
            pending.size === 0 &&
            lines.some((l) => l.qty > exchanges.flatMap((e) => e.items).filter((i) => i.saleItemId === l._id).reduce((n, i) => n + i.qty, 0)),
          balance: sale.creditStatus ? saleBalance(sale) : null,
          payments,
          locationName: location?.name ?? null,
          soldByName: seller?.name || seller?.email || null,
          lines,
          totalQty: lines.reduce((s, l) => s + l.qty, 0),
          margin: sale.totalAmount - sale.totalCost,
          backdated:
            sale.recordedAt !== undefined && businessDayOf(sale.recordedAt) !== businessDayOf(sale.createdAt),
        };
      }),
    );
    return { ...result, page };
  },
});

/** Locations the sales list can filter by (own_location viewers: just theirs). */
export const filterLocations = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("sales.view");
    await requireBusinessUnit(ctx, businessUnitKey);
    return await filterableLocations(ctx, scope);
  },
});

/** Whether a correction of the sale is waiting for approval. */
async function hasPendingEdit(ctx: QueryCtx, saleId: Id<"sales">): Promise<boolean> {
  return (await pendingSaleApprovals(ctx, saleId)).has("sale_edit");
}

/**
 * What the correction form needs: the sale's lines with their product,
 * price at sale time, suggested price then, and how many more of the lot
 * the sale's location still holds (for raising a quantity).
 */
export const editOptions = authedQuery({
  args: { saleId: v.id("sales") },
  handler: async (ctx, { saleId }) => {
    const sale = await ctx.db.get("sales", saleId);
    if (!sale) return null;
    await ctx.requirePermission("sales.edit.request", (scope, user) => inScope(scope, user, sale.locationId));
    const holder = await findHolder(ctx, sale.businessUnitId, { type: "location", refId: sale.locationId });
    const items = await saleItemsOf(ctx, sale._id);
    const lines = await Promise.all(
      items.map(async (item) => {
        const product = await ctx.db.get("products", item.productId);
        const level = holder ? await stockLevelOf(ctx, item.inventoryBatchId, holder._id) : null;
        return {
          saleItemId: item._id,
          ...(await describeProduct(ctx, item.productId)),
          photoUrl: product?.photoFileId ? await ctx.storage.getUrl(product.photoFileId) : null,
          qty: item.qty,
          unitPrice: item.unitPrice,
          discountReason: item.discountReason ?? null,
          suggestedPrice: item.suggestedPriceSnapshot ?? null,
          available: level?.qtyOnHand ?? 0,
        };
      }),
    );
    return {
      _id: sale._id,
      number: sale.number,
      status: sale.status,
      soldOn: businessDayOf(sale.createdAt),
      paymentMethod: sale.paymentMethod,
      customerName: sale.customerName ?? null,
      isCredit: sale.paymentMethod === "credit",
      amountPaid: sale.amountPaid ?? 0,
      linesTotal: sale.linesTotal ?? sale.totalAmount,
      totalAmount: sale.totalAmount,
      saleDiscountReason: sale.saleDiscountReason ?? null,
      pendingEdit: await hasPendingEdit(ctx, sale._id),
      lines,
    };
  },
});

/**
 * Asks for a sale to be corrected (approval type sale_edit, decided by
 * sales.edit.approve holders - never the requester, except the Super
 * Admin). Checked now with the same rules as when it's applied
 * (convex/lib/saleEdits.ts); nothing changes until it's approved.
 */
export const requestEdit = authedMutation({
  args: { saleId: v.id("sales"), reason: v.string(), changes: saleEditChangesValidator },
  handler: async (ctx, { saleId, reason, changes }) => {
    const sale = await ctx.db.get("sales", saleId);
    if (!sale) throw new ConvexError("Sale not found.");
    await ctx.requirePermission("sales.edit.request", (scope, user) => inScope(scope, user, sale.locationId));
    const cleanReason = reason.trim();
    if (!cleanReason) throw new ConvexError("Say why this sale needs a correction.");
    if (cleanReason.length > 300) throw new ConvexError("The reason is too long.");
    const plan = await planSaleEdit(ctx, sale, changes, Date.now());
    if (!plan.changed) throw new ConvexError("Nothing was changed.");
    return await requestApproval(ctx, {
      type: "sale_edit",
      businessUnitId: sale.businessUnitId,
      locationId: sale.locationId,
      entityTable: "sales",
      entityId: sale._id,
      payload: { before: plan.before, after: plan.after, changes, baseline: plan.baseline },
      reason: cleanReason,
    });
  },
});

/** A sale's exchanges, oldest first, with their lines described. */
async function exchangesOf(ctx: QueryCtx, saleId: Id<"sales">) {
  const exchanges = await ctx.db
    .query("saleExchanges")
    .withIndex("by_saleId", (q) => q.eq("saleId", saleId))
    .take(50);
  return await Promise.all(
    exchanges.map(async (exchange) => {
      const [items, recorder] = await Promise.all([
        ctx.db
          .query("saleExchangeItems")
          .withIndex("by_exchangeId", (q) => q.eq("exchangeId", exchange._id))
          .take(MAX_SALE_LINES * 2),
        ctx.db.get("users", exchange.recordedBy),
      ]);
      return {
        _id: exchange._id,
        number: exchange.number,
        createdAt: exchange.createdAt,
        returnedAmount: exchange.returnedAmount,
        givenTotal: exchange.givenTotal,
        differenceAmount: exchange.differenceAmount,
        settlementMethod: exchange.settlementMethod ?? null,
        reason: exchange.reason ?? null,
        recordedByName: recorder?.name || recorder?.email || null,
        items: await Promise.all(
          items.map(async (item) => ({
            _id: item._id,
            direction: item.direction,
            saleItemId: item.saleItemId ?? null,
            qty: item.qty,
            unitPrice: item.unitPrice,
            ...(await describeProduct(ctx, item.productId)),
          })),
        ),
      };
    }),
  );
}

/**
 * What the exchange form needs: the sale's lines with how many units can
 * still be brought back and what each unit was paid (its price less its
 * share of a whole-sale discount), and every lot in stock at the sale's
 * location to give instead.
 */
export const exchangeOptions = authedQuery({
  args: { saleId: v.id("sales") },
  handler: async (ctx, { saleId }) => {
    const sale = await ctx.db.get("sales", saleId);
    if (!sale) return null;
    await ctx.requirePermission("sales.create", (scope, user) => inScope(scope, user, sale.locationId));
    const items = await saleItemsOf(ctx, sale._id);
    const lines = await Promise.all(
      items.map(async (item) => {
        const product = await ctx.db.get("products", item.productId);
        const already = await returnedSoFar(ctx, item._id);
        return {
          saleItemId: item._id,
          ...(await describeProduct(ctx, item.productId)),
          photoUrl: product?.photoFileId ? await ctx.storage.getUrl(product.photoFileId) : null,
          qty: item.qty,
          unitPrice: item.unitPrice,
          saleDiscountShare: item.saleDiscountShare ?? 0,
          alreadyReturned: already,
          returnable: item.qty - already,
        };
      }),
    );
    const pending = await pendingSaleApprovals(ctx, sale._id);
    const location = await ctx.db.get("locations", sale.locationId);
    return {
      _id: sale._id,
      number: sale.number,
      createdAt: sale.createdAt,
      locationName: location?.name ?? null,
      totalAmount: sale.totalAmount,
      // Why it can't be exchanged now, if so (shown instead of the form).
      refusal: exchangeRefusal(sale, Date.now()),
      pendingEdit: pending.has("sale_edit"),
      pendingExchange: pending.has("sale_exchange"),
      lines,
      lots: await lotsAt(ctx, sale.businessUnitId, sale.locationId),
    };
  },
});

/**
 * A customer brings products of a sale back and takes others, at the sale's
 * location (convex/lib/exchanges.ts). Scoped like sales.create. When the
 * customer pays the difference (or it's even) it's recorded now; a refund
 * waits for approval (sale_exchange, decided by sales.edit.approve holders).
 */
export const exchange = authedMutation({
  args: { saleId: v.id("sales"), changes: saleExchangeChangesValidator, reason: v.optional(v.string()) },
  handler: async (ctx, { saleId, changes, reason }) => {
    const sale = await ctx.db.get("sales", saleId);
    if (!sale) throw new ConvexError("Sale not found.");
    await ctx.requirePermission("sales.create", (scope, user) => inScope(scope, user, sale.locationId));
    const pending = await pendingSaleApprovals(ctx, sale._id);
    if (pending.has("sale_edit")) throw new ConvexError("A correction of this sale is waiting for approval.");
    if (pending.has("sale_exchange")) throw new ConvexError("An exchange of this sale is already waiting for approval.");
    const cleanReason = reason?.trim() || undefined;
    if (cleanReason && cleanReason.length > 300) throw new ConvexError("The reason is too long.");

    const plan = await planExchange(ctx, sale, changes, Date.now());
    if (plan.differenceAmount >= 0) {
      const done = await applyExchange(ctx, sale, plan, {
        recordedBy: ctx.user._id,
        actorId: ctx.user._id,
        ...(cleanReason ? { reason: cleanReason } : {}),
      });
      return { status: "completed" as const, ...done, differenceAmount: plan.differenceAmount };
    }
    if (!cleanReason) throw new ConvexError("Say why the money is given back.");
    const approvalId = await requestApproval(ctx, {
      type: "sale_exchange",
      businessUnitId: sale.businessUnitId,
      locationId: sale.locationId,
      entityTable: "sales",
      entityId: sale._id,
      payload: { after: plan.snapshot, changes },
      reason: cleanReason,
    });
    return { status: "pending" as const, approvalId, differenceAmount: plan.differenceAmount };
  },
});
