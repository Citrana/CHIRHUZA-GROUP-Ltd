import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyMovement, findHolder, getOrCreateHolder, stockLevelOf } from "./inventory";
import { applyRollupEvents, exchangeEvents } from "./analytics";
import { collectionMethodValidator } from "./credit";
import { describeProduct } from "./products";
import { nextSequenceNumber } from "./requisitions";
import { saleItemsOf } from "./saleEdits";
import { MAX_EXCHANGE_DAYS, MAX_SALE_LINES, returnedDiscountShare, saleLineProblems } from "./sales";
import { addBusinessDays, businessDayOf } from "./time";

/**
 * Exchanges (CLAUDE.md "Sales"): a customer brings products of a cash /
 * mobile money sale back (up to MAX_EXCHANGE_DAYS after it) and takes
 * others at the sale's location, paying the difference or getting it back.
 *   - returned units go back into their own lot at the location ("return"
 *     movements), given units leave it ("sale" movements);
 *   - the rollups move on the exchange's day: the returned units' revenue
 *     and cost come out (saleEvents, sign -1), the given ones go in - so
 *     revenue moves by exactly the difference;
 *   - difference >= 0: recorded at once by the seller (sales.create);
 *     difference < 0 (a refund): approval type sale_exchange first.
 * The sale itself is never rewritten. `planExchange` holds the rules for
 * both the request and the approval.
 */

export const saleExchangeChangesValidator = v.object({
  // Units brought back, per line of the sale.
  returned: v.array(v.object({ saleItemId: v.id("saleItems"), qty: v.number() })),
  // Units taken instead, per lot at the sale's location.
  given: v.array(
    v.object({
      inventoryBatchId: v.id("inventoryBatches"),
      qty: v.number(),
      unitPrice: v.number(),
      discountReason: v.optional(v.string()),
    }),
  ),
  // How the difference is paid or refunded; required unless it is 0.
  settlementMethod: v.optional(collectionMethodValidator),
});
export type SaleExchangeChanges = Infer<typeof saleExchangeChangesValidator>;

/** Units of each sale line already returned by earlier exchanges. */
export async function returnedSoFar(ctx: QueryCtx, saleItemId: Id<"saleItems">): Promise<number> {
  const rows = await ctx.db
    .query("saleExchangeItems")
    .withIndex("by_saleItemId", (q) => q.eq("saleItemId", saleItemId))
    .take(500);
  return rows.reduce((s, r) => s + r.qty, 0);
}

/** Whether a sale can have products exchanged at all (not checking approvals). */
export function exchangeRefusal(sale: Doc<"sales">, now: number): string | null {
  if (sale.status !== "completed") return "Only a completed sale can have products exchanged.";
  if (sale.paymentMethod === "credit") return "Products of a credit sale can't be exchanged.";
  if (businessDayOf(sale.createdAt) < addBusinessDays(businessDayOf(now), -MAX_EXCHANGE_DAYS)) {
    return `Products can be exchanged up to ${MAX_EXCHANGE_DAYS} days after the sale.`;
  }
  return null;
}

/**
 * Checks an exchange against the sale and the stock as they are now and
 * works out the lines, totals and the snapshot for the Approvals page.
 * Throws a ConvexError naming the first problem.
 */
export async function planExchange(ctx: QueryCtx, sale: Doc<"sales">, changes: SaleExchangeChanges, now: number) {
  const refusal = exchangeRefusal(sale, now);
  if (refusal) throw new ConvexError(refusal);
  if (changes.returned.length === 0) throw new ConvexError("Choose what the customer brings back.");
  if (changes.given.length === 0) throw new ConvexError("Choose what the customer takes instead.");
  if (changes.given.length > MAX_SALE_LINES) throw new ConvexError(`At most ${MAX_SALE_LINES} lines.`);
  if (new Set(changes.returned.map((r) => r.saleItemId)).size !== changes.returned.length) {
    throw new ConvexError("Each line of the sale can appear only once.");
  }
  if (new Set(changes.given.map((g) => g.inventoryBatchId)).size !== changes.given.length) {
    throw new ConvexError("Each lot can appear only once.");
  }

  const items = new Map((await saleItemsOf(ctx, sale._id)).map((i) => [i._id, i]));
  const returned = [];
  for (const r of changes.returned) {
    const item = items.get(r.saleItemId);
    if (!item) throw new ConvexError("That line is not part of this sale.");
    const described = await describeProduct(ctx, item.productId);
    const name = described.productName ?? "A product";
    if (!Number.isSafeInteger(r.qty) || r.qty < 1) throw new ConvexError("Quantities must be whole numbers from 1.");
    const already = await returnedSoFar(ctx, item._id);
    if (r.qty > item.qty - already) {
      throw new ConvexError(`Only ${item.qty - already} of ${name} can still be brought back.`);
    }
    const saleDiscountShare = returnedDiscountShare(item, already, r.qty);
    const lot = await ctx.db.get("inventoryBatches", item.inventoryBatchId);
    const batch = lot ? await ctx.db.get("stockBatches", lot.stockBatchId) : null;
    returned.push({
      item,
      qty: r.qty,
      saleDiscountShare,
      value: item.unitPrice * r.qty - saleDiscountShare,
      described,
      batchNumber: batch?.number ?? null,
    });
  }

  const holder = await findHolder(ctx, sale.businessUnitId, { type: "location", refId: sale.locationId });
  const given = [];
  for (const g of changes.given) {
    const lot = await ctx.db.get("inventoryBatches", g.inventoryBatchId);
    if (!lot || lot.businessUnitId !== sale.businessUnitId) throw new ConvexError("Stock lot not found.");
    const product = await ctx.db.get("products", lot.productId);
    const described = await describeProduct(ctx, lot.productId);
    const name = described.productName ?? "A product";
    const discountReason = g.discountReason?.trim() || undefined;
    const problems = saleLineProblems({ ...g, discountReason }, product?.suggestedPrice);
    if (problems.includes("qty")) throw new ConvexError("Quantities must be whole numbers from 1.");
    if (problems.includes("price")) throw new ConvexError("Prices must be whole cents from 0.");
    if (problems.includes("discountReason")) {
      throw new ConvexError(`${name} is at another price than suggested: give a reason.`);
    }
    if (discountReason && discountReason.length > 300) throw new ConvexError("A price reason is too long.");
    // Units brought back into the same lot can go straight out again.
    const level = holder ? await stockLevelOf(ctx, lot._id, holder._id) : null;
    const comingBack = returned.filter((r) => r.item.inventoryBatchId === lot._id).reduce((s, r) => s + r.qty, 0);
    const available = (level?.qtyOnHand ?? 0) + comingBack;
    if (g.qty > available) throw new ConvexError(`Only ${available} of ${name} left at the sale's location.`);
    const batch = await ctx.db.get("stockBatches", lot.stockBatchId);
    given.push({
      lot,
      qty: g.qty,
      unitPrice: g.unitPrice,
      suggestedPrice: product?.suggestedPrice,
      discountReason,
      described,
      batchNumber: batch?.number ?? null,
    });
  }

  const returnedAmount = returned.reduce((s, r) => s + r.value, 0);
  const givenTotal = given.reduce((s, g) => s + g.unitPrice * g.qty, 0);
  const differenceAmount = givenTotal - returnedAmount;
  if (differenceAmount !== 0 && !changes.settlementMethod) {
    throw new ConvexError(differenceAmount > 0 ? "Say how the customer pays the difference." : "Say how the money is given back.");
  }
  const settlementMethod = differenceAmount !== 0 ? changes.settlementMethod : undefined;

  const productOf = (d: Awaited<ReturnType<typeof describeProduct>>, batch: string | null) => ({
    product: d.productName ?? "—",
    lengthInches: d.lengthInches,
    size: d.sizeName,
    colour: d.colourName,
    sku: d.sku,
    batch,
  });
  const snapshot = {
    sale: sale.number,
    returned: returned.map((r) => ({
      ...productOf(r.described, r.batchNumber),
      qty: r.qty,
      unitPrice: r.item.unitPrice,
      returnedAmount: r.value,
    })),
    given: given.map((g) => ({
      ...productOf(g.described, g.batchNumber),
      qty: g.qty,
      unitPrice: g.unitPrice,
      discountReason: g.discountReason ?? null,
    })),
    returnedAmount,
    givenTotal,
    differenceAmount,
    settlementMethod: settlementMethod ?? null,
    currency: "USD",
  };

  return { returned, given, returnedAmount, givenTotal, differenceAmount, settlementMethod, snapshot };
}

export type ExchangePlan = Awaited<ReturnType<typeof planExchange>>;

/**
 * Applies a planned exchange in the caller's mutation: the exchange and its
 * lines, the stock (returns first, so a returned unit can go out again),
 * the rollups on today's business day, and the audit entry.
 */
export async function applyExchange(
  ctx: MutationCtx,
  sale: Doc<"sales">,
  plan: ExchangePlan,
  args: {
    recordedBy: Id<"users">;
    actorId: Id<"users">;
    reason?: string;
    approvalId?: Id<"approvals">;
  },
): Promise<{ exchangeId: Id<"saleExchanges">; number: string }> {
  const createdAt = Date.now();
  const number = await nextSequenceNumber(ctx, sale.businessUnitId, "exchange", "EXCH");
  const exchangeId = await ctx.db.insert("saleExchanges", {
    businessUnitId: sale.businessUnitId,
    number,
    saleId: sale._id,
    locationId: sale.locationId,
    recordedBy: args.recordedBy,
    ...(args.approvalId ? { approvalId: args.approvalId, approvedBy: args.actorId } : {}),
    returnedAmount: plan.returnedAmount,
    givenTotal: plan.givenTotal,
    differenceAmount: plan.differenceAmount,
    currency: "USD",
    ...(plan.settlementMethod ? { settlementMethod: plan.settlementMethod } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
    createdAt,
  });

  const location = await getOrCreateHolder(ctx, sale.businessUnitId, { type: "location", refId: sale.locationId });
  const returnedItems = [];
  for (const r of plan.returned) {
    const row = {
      exchangeId,
      saleId: sale._id,
      direction: "returned" as const,
      saleItemId: r.item._id,
      productId: r.item.productId,
      inventoryBatchId: r.item.inventoryBatchId,
      qty: r.qty,
      unitPrice: r.item.unitPrice,
      unitCostSnapshot: r.item.unitCostSnapshot,
      ...(r.item.suggestedPriceSnapshot !== undefined ? { suggestedPriceSnapshot: r.item.suggestedPriceSnapshot } : {}),
      ...(r.saleDiscountShare > 0 ? { saleDiscountShare: r.saleDiscountShare } : {}),
      currency: "USD" as const,
    };
    await ctx.db.insert("saleExchangeItems", row);
    returnedItems.push(row);
    await applyMovement(ctx, {
      type: "return",
      inventoryBatchId: r.item.inventoryBatchId,
      toHolderId: location,
      qty: r.qty,
      refTable: "saleExchanges",
      refId: exchangeId,
      actorId: args.actorId,
    });
  }
  const givenItems = [];
  for (const g of plan.given) {
    const row = {
      exchangeId,
      saleId: sale._id,
      direction: "given" as const,
      productId: g.lot.productId,
      inventoryBatchId: g.lot._id,
      qty: g.qty,
      unitPrice: g.unitPrice,
      unitCostSnapshot: g.lot.unitCost,
      ...(g.suggestedPrice !== undefined ? { suggestedPriceSnapshot: g.suggestedPrice } : {}),
      ...(g.discountReason ? { discountReason: g.discountReason } : {}),
      currency: "USD" as const,
    };
    await ctx.db.insert("saleExchangeItems", row);
    givenItems.push(row);
    try {
      await applyMovement(ctx, {
        type: "sale",
        inventoryBatchId: g.lot._id,
        fromHolderId: location,
        qty: g.qty,
        refTable: "saleExchanges",
        refId: exchangeId,
        actorId: args.actorId,
      });
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; onHand?: number }) : null;
      if (data?.code === "INSUFFICIENT_STOCK") {
        throw new ConvexError(
          `Only ${data.onHand ?? 0} left of ${g.described.productName ?? "a product"} at the sale's location.`,
        );
      }
      throw e;
    }
  }

  await applyRollupEvents(ctx, sale.businessUnitId, exchangeEvents({ locationId: sale.locationId, createdAt }, returnedItems, givenItems));

  await logAudit(ctx, {
    actorId: args.actorId,
    action: "create",
    entityTable: "saleExchanges",
    entityId: exchangeId,
    businessUnitId: sale.businessUnitId,
    after: {
      number,
      exchangedOn: businessDayOf(createdAt),
      ...plan.snapshot,
      ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    },
    ...(args.reason ? { reason: args.reason } : {}),
  });
  return { exchangeId, number };
}

/**
 * APPROVAL_HANDLERS.sale_exchange (a refund): re-plans the exchange against
 * the sale and stock as they are now; if the refund changed meanwhile (the
 * sale or stock moved), it throws and the approval stays pending.
 */
export async function applySaleExchangeApproval(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const sale = await ctx.db.get("sales", approval.entityId as Id<"sales">);
  if (!sale) throw new ConvexError("Sale not found.");
  const payload = approval.payload as { changes: SaleExchangeChanges; after: { differenceAmount: number } };
  // The time limit counts to when it was asked for, not when it's decided.
  const plan = await planExchange(ctx, sale, payload.changes, approval._creationTime);
  if (plan.differenceAmount !== payload.after.differenceAmount) {
    throw new ConvexError("The sale changed since this exchange was asked for: reject it and ask again.");
  }
  await applyExchange(ctx, sale, plan, {
    recordedBy: approval.requestedBy,
    actorId: decider._id,
    ...(approval.reason ? { reason: approval.reason } : {}),
    approvalId: approval._id,
  });
}
