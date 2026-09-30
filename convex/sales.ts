import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery, type AuthedQueryCtx } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { nextSequenceNumber } from "./lib/requisitions";
import { applyMovement, findHolder, getOrCreateHolder } from "./lib/inventory";
import { businessDayEndUtc, businessDayOf, businessDayStartUtc } from "./lib/time";
import {
  MAX_BACKDATE_DAYS,
  MAX_SALE_LINES,
  lineMargin,
  paymentMethodValidator,
  saleLineProblems,
  saleTimestamp,
} from "./lib/sales";

/**
 * Sales (convex/lib/sales.ts). sales.create records a sale; its scope is
 * the location lock: own_location sells only at the seller's own location,
 * all_locations anywhere (Chief Sales Admin, Super Admin). sales.view lists
 * them, own_location viewers seeing only their location.
 */

async function describeProduct(ctx: QueryCtx, productId: Id<"products">) {
  const product = await ctx.db.get("products", productId);
  const colour = product?.colourId ? await ctx.db.get("productColours", product.colourId) : null;
  return {
    productName: product?.name ?? null,
    sku: product?.sku ?? null,
    lengthInches: product?.lengthInches ?? null,
    colourName: colour?.name ?? null,
  };
}

/** The locations this caller may sell at (own_location: just their own). */
async function sellableLocations(ctx: AuthedQueryCtx, unitId: Id<"businessUnits">, scope: "own_location" | "all_locations") {
  if (scope === "own_location") {
    const own = ctx.user.locationId ? await ctx.db.get("locations", ctx.user.locationId) : null;
    return own && own.businessUnitId === unitId && own.active ? [own] : [];
  }
  return (
    await ctx.db
      .query("locations")
      .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unitId))
      .take(500)
  )
    .filter((l) => l.active)
    .sort((a, b) => a.name.localeCompare(b.name));
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
    const locations = await sellableLocations(ctx, unit._id, scope);
    const location =
      scope === "own_location"
        ? (locations[0] ?? null)
        : (locations.find((l) => l._id === args.locationId) ?? null);

    const lots = [];
    const holder = location ? await findHolder(ctx, unit._id, { type: "location", refId: location._id }) : null;
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
          batchNumber: batch?.number ?? null,
          lotDate: lot.createdAt,
          unitCost: lot.unitCost,
          onHand: level.qtyOnHand,
        });
      }
    }
    lots.sort((a, b) => (a.productName ?? "").localeCompare(b.productName ?? "") || a.lotDate - b.lotDate);
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
    customerName: v.optional(v.string()),
    paymentMethod: paymentMethodValidator,
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
    if (!location || location.businessUnitId !== unit._id || !location.active) {
      throw new ConvexError("Choose an active location of this service.");
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
    const customerName = args.customerName?.trim() || undefined;
    if (customerName && customerName.length > 120) throw new ConvexError("Customer name is too long.");
    if (args.paymentMethod === "credit" && !customerName) {
      throw new ConvexError("A credit sale needs the customer's name.");
    }

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

    // 3. Record the sale with each line's cost snapshot.
    const totalAmount = lines.reduce((s, l) => s + l.line.unitPrice * l.line.qty, 0);
    const totalCost = lines.reduce((s, l) => s + l.lot.unitCost * l.line.qty, 0);
    const number = await nextSequenceNumber(ctx, unit._id, "sale", "SALE");
    const createdAt = when.createdAt;
    const saleId = await ctx.db.insert("sales", {
      businessUnitId: unit._id,
      number,
      locationId: location._id,
      soldBy: ctx.user._id,
      ...(customerName ? { customerName } : {}),
      paymentMethod: args.paymentMethod,
      currency: "USD",
      totalAmount,
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
    for (const { line, lot, product, discountReason } of lines) {
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
          colour: described.colourName,
          sku: described.sku,
          batch: batchNumber,
          qty: line.qty,
          unitPrice: line.unitPrice,
          discountReason: discountReason ?? null,
        })),
        totalAmount,
        currency: "USD",
        status: "completed",
      },
    });
    return { saleId, number, soldOn: businessDayOf(createdAt), recordedOn: businessDayOf(recordedAt) };
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
 * Sales, newest first, with their lines and margins. Filters: location and
 * business days (Lubumbashi time). own_location viewers only ever see their
 * own location's sales.
 */
export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    locationId: v.optional(v.id("locations")),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
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
      if (!location || location.businessUnitId !== unit._id) {
        return { page: [], isDone: true, continueCursor: "" };
      }
    }
    const { start, end } = dayRange(args.from, args.to);

    const result = locationId
      ? await ctx.db
          .query("sales")
          .withIndex("by_locationId_and_createdAt", (q) => {
            const eq = q.eq("locationId", locationId);
            const lower = start !== undefined ? eq.gte("createdAt", start) : eq;
            return end !== undefined ? lower.lte("createdAt", end) : lower;
          })
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("sales")
          .withIndex("by_businessUnitId_and_createdAt", (q) => {
            const eq = q.eq("businessUnitId", unit._id);
            const lower = start !== undefined ? eq.gte("createdAt", start) : eq;
            return end !== undefined ? lower.lte("createdAt", end) : lower;
          })
          .order("desc")
          .paginate(args.paginationOpts);

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
        return {
          ...sale,
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
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    if (scope === "own_location") {
      const own = ctx.user.locationId ? await ctx.db.get("locations", ctx.user.locationId) : null;
      return { locked: true, locations: own && own.businessUnitId === unit._id ? [{ _id: own._id, name: own.name }] : [] };
    }
    const locations = await ctx.db
      .query("locations")
      .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
      .take(500);
    return {
      locked: false,
      locations: locations.map((l) => ({ _id: l._id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});
