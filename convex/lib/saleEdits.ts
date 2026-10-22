import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit, diff } from "./audit";
import { applyMovement, findHolder, getOrCreateHolder, stockLevelOf } from "./inventory";
import { applyRollupEvents, saleEvents } from "./analytics";
import { applySaleTotalChange, splitDiscount } from "./credit";
import { describeProduct } from "./products";
import { MAX_BACKDATE_DAYS, MAX_SALE_LINES, paymentMethodValidator, saleLineProblems, saleTimestamp } from "./sales";
import { businessDayOf } from "./time";

/**
 * Sale corrections (approval type `sale_edit`). Anyone with
 * sales.edit.request asks for one with a reason (sales.requestEdit); a
 * sales.edit.approve holder decides it, and `applySaleEdit` applies it.
 * Both sides run the same `planSaleEdit`, so the rules live in one place:
 *   - each line (one saleItems row = one lot): quantity (0 removes it; an
 *     increase comes from the same lot at the sale's location), unit price,
 *     and a reason when the price differs from the suggested one at sale time;
 *   - the agreed total (never above the lines, lower with a reason);
 *   - payment method between cash and mobile money (credit stays credit:
 *     its customer and payments can't move), the customer's name on a
 *     non-credit sale, and the date (today or up to MAX_BACKDATE_DAYS back);
 *   - a credit sale's new total can't be below what was already paid.
 */

export const saleEditChangesValidator = v.object({
  // Every line of the sale, with its corrected values.
  lines: v.array(
    v.object({
      saleItemId: v.id("saleItems"),
      qty: v.number(),
      unitPrice: v.number(),
      discountReason: v.optional(v.string()),
    }),
  ),
  // Missing = the corrected lines' total.
  agreedTotal: v.optional(v.number()),
  saleDiscountReason: v.optional(v.string()),
  // Missing = unchanged.
  paymentMethod: v.optional(paymentMethodValidator),
  // Non-credit sales; missing = unchanged, empty = no name.
  customerName: v.optional(v.string()),
  // YYYY-MM-DD; missing = unchanged.
  soldOn: v.optional(v.string()),
});
export type SaleEditChanges = Infer<typeof saleEditChangesValidator>;

/** What the sale looked like when the correction was asked for. */
type Baseline = {
  items: Array<[Id<"saleItems">, number, number]>;
  totalAmount: number;
  createdAt: number;
  paymentMethod: Doc<"sales">["paymentMethod"];
};

function baselineOf(sale: Doc<"sales">, items: Doc<"saleItems">[]): Baseline {
  return {
    items: items.map((i) => [i._id, i.qty, i.unitPrice]),
    totalAmount: sale.totalAmount,
    createdAt: sale.createdAt,
    paymentMethod: sale.paymentMethod,
  };
}

/** Field by field: stored payloads don't keep object key order. */
function sameBaseline(a: Baseline, b: Baseline): boolean {
  return (
    a.totalAmount === b.totalAmount &&
    a.createdAt === b.createdAt &&
    a.paymentMethod === b.paymentMethod &&
    JSON.stringify(a.items) === JSON.stringify(b.items)
  );
}

export async function saleItemsOf(ctx: QueryCtx, saleId: Id<"sales">) {
  return await ctx.db
    .query("saleItems")
    .withIndex("by_saleId", (q) => q.eq("saleId", saleId))
    .take(MAX_SALE_LINES);
}

/**
 * Checks a correction against the sale as it is now and works out the
 * result: the corrected lines (qty 0 = removed), totals, sale fields, the
 * before/after snapshots for the Approvals page, and whether anything
 * changed at all. Throws a ConvexError naming the first problem.
 */
export async function planSaleEdit(ctx: QueryCtx, sale: Doc<"sales">, changes: SaleEditChanges, now: number) {
  if (sale.status !== "completed") throw new ConvexError("Only a completed sale can be corrected.");
  const items = await saleItemsOf(ctx, sale._id);
  const byId = new Map(changes.lines.map((l) => [l.saleItemId, l]));
  if (byId.size !== changes.lines.length || items.length !== byId.size || items.some((i) => !byId.has(i._id))) {
    throw new ConvexError("The correction must list every line of the sale once.");
  }

  const holder = await findHolder(ctx, sale.businessUnitId, { type: "location", refId: sale.locationId });
  const lines = await Promise.all(
    items.map(async (item) => {
      const line = byId.get(item._id)!;
      const described = await describeProduct(ctx, item.productId);
      const name = described.productName ?? "A product";
      const discountReason = line.discountReason?.trim() || undefined;
      if (line.qty !== 0) {
        const problems = saleLineProblems({ ...line, discountReason }, item.suggestedPriceSnapshot);
        if (problems.includes("qty")) throw new ConvexError("Quantities must be whole numbers from 0.");
        if (problems.includes("price")) throw new ConvexError("Prices must be whole cents from 0.");
        if (problems.includes("discountReason")) {
          throw new ConvexError(`${name} is at another price than suggested: give a reason.`);
        }
      }
      if (discountReason && discountReason.length > 300) throw new ConvexError("A price reason is too long.");
      if (line.qty > item.qty) {
        const level = holder ? await stockLevelOf(ctx, item.inventoryBatchId, holder._id) : null;
        const available = level?.qtyOnHand ?? 0;
        if (line.qty - item.qty > available) {
          throw new ConvexError(`Only ${available} more of ${name} left at the sale's location.`);
        }
      }
      const lot = await ctx.db.get("inventoryBatches", item.inventoryBatchId);
      const batch = lot ? await ctx.db.get("stockBatches", lot.stockBatchId) : null;
      return { item, qty: line.qty, unitPrice: line.unitPrice, discountReason, described, batchNumber: batch?.number ?? null };
    }),
  );
  const kept = lines.filter((l) => l.qty > 0);
  if (kept.length === 0) throw new ConvexError("A sale keeps at least one product.");

  // The agreed total, as when recording the sale.
  const linesTotal = kept.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const totalAmount = changes.agreedTotal ?? linesTotal;
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) throw new ConvexError("The total must be whole cents from 0.");
  if (totalAmount > linesTotal) throw new ConvexError("The total to pay can't be more than the lines' total.");
  const saleDiscountReason = totalAmount < linesTotal ? changes.saleDiscountReason?.trim() || undefined : undefined;
  if (totalAmount < linesTotal && !saleDiscountReason) throw new ConvexError("Say why the total is lower than the lines' total.");
  if (saleDiscountReason && saleDiscountReason.length > 300) throw new ConvexError("The discount reason is too long.");
  const shares = splitDiscount(
    kept.map((l) => l.unitPrice * l.qty),
    linesTotal - totalAmount,
  );

  const isCredit = sale.paymentMethod === "credit";
  const paymentMethod = changes.paymentMethod ?? sale.paymentMethod;
  if (isCredit !== (paymentMethod === "credit")) {
    throw new ConvexError("A sale can't be switched to or from credit.");
  }
  let customerName = sale.customerName;
  if (changes.customerName !== undefined && changes.customerName.trim() !== (sale.customerName ?? "")) {
    if (isCredit) throw new ConvexError("A credit sale's customer can't be changed.");
    customerName = changes.customerName.trim() || undefined;
    if (customerName && customerName.length > 120) throw new ConvexError("Customer name is too long.");
  }
  if (isCredit && totalAmount < (sale.amountPaid ?? 0)) {
    throw new ConvexError("The new total is less than what the customer already paid: reverse a payment first.");
  }

  let createdAt = sale.createdAt;
  if (changes.soldOn !== undefined && changes.soldOn !== businessDayOf(sale.createdAt)) {
    const when = saleTimestamp(changes.soldOn, now);
    if ("problem" in when) {
      throw new ConvexError(
        when.problem === "future"
          ? "A sale can't be dated in the future."
          : when.problem === "tooOld"
            ? `Pick today or one of the last ${MAX_BACKDATE_DAYS} days.`
            : "The sale date must be YYYY-MM-DD.",
      );
    }
    createdAt = when.createdAt;
  }

  const itemSnapshot = (l: (typeof lines)[number], qty: number, unitPrice: number, discountReason: string | undefined) => ({
    product: l.described.productName ?? "—",
    lengthInches: l.described.lengthInches,
    size: l.described.sizeName,
    colour: l.described.colourName,
    sku: l.described.sku,
    batch: l.batchNumber,
    qty,
    unitPrice,
    discountReason: discountReason ?? null,
  });
  const before = {
    number: sale.number,
    soldOn: businessDayOf(sale.createdAt),
    paymentMethod: sale.paymentMethod,
    customerName: sale.customerName ?? null,
    items: lines.map((l) => itemSnapshot(l, l.item.qty, l.item.unitPrice, l.item.discountReason)),
    linesTotal: sale.linesTotal ?? sale.totalAmount,
    totalAmount: sale.totalAmount,
    saleDiscountReason: sale.saleDiscountReason ?? null,
    currency: "USD",
  };
  const after = {
    ...before,
    soldOn: businessDayOf(createdAt),
    paymentMethod,
    customerName: customerName ?? null,
    items: kept.map((l) => itemSnapshot(l, l.qty, l.unitPrice, l.discountReason)),
    linesTotal,
    totalAmount,
    saleDiscountReason: saleDiscountReason ?? null,
  };

  return {
    items,
    lines: lines.map((l) => ({ ...l, saleDiscountShare: l.qty > 0 ? shares[kept.indexOf(l)] : 0 })),
    linesTotal,
    totalAmount,
    totalCost: kept.reduce((s, l) => s + l.item.unitCostSnapshot * l.qty, 0),
    saleDiscountReason,
    paymentMethod,
    customerName,
    createdAt,
    before,
    after,
    changed: JSON.stringify(before) !== JSON.stringify(after),
    baseline: baselineOf(sale, items),
  };
}

/**
 * APPROVAL_HANDLERS.sale_edit: applies an approved correction in the
 * decision's transaction (a throw keeps the approval pending). Re-checks
 * it against the sale as it is now, then: reverses the sale's rollups,
 * moves the quantity differences through applyMovement (return / sale at
 * the sale's location), rewrites the lines and the sale, applies the new
 * rollups, follows a credit sale's balance, and audits it.
 */
export async function applySaleEdit(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const sale = await ctx.db.get("sales", approval.entityId as Id<"sales">);
  if (!sale) throw new ConvexError("Sale not found.");
  const payload = approval.payload as { changes: SaleEditChanges; baseline: Baseline };
  const plan = await planSaleEdit(ctx, sale, payload.changes, Date.now());
  if (!sameBaseline(plan.baseline, payload.baseline)) {
    throw new ConvexError("The sale changed since this correction was asked for: reject it and ask again.");
  }

  await applyRollupEvents(ctx, sale.businessUnitId, saleEvents(sale, plan.items, -1));

  const location = await getOrCreateHolder(ctx, sale.businessUnitId, { type: "location", refId: sale.locationId });
  for (const line of plan.lines) {
    const delta = line.qty - line.item.qty;
    if (delta !== 0) {
      try {
        await applyMovement(ctx, {
          type: delta < 0 ? "return" : "sale",
          inventoryBatchId: line.item.inventoryBatchId,
          ...(delta < 0 ? { toHolderId: location } : { fromHolderId: location }),
          qty: Math.abs(delta),
          refTable: "sales",
          refId: sale._id,
          actorId: decider._id,
        });
      } catch (e) {
        const data = e instanceof ConvexError ? (e.data as { code?: string; onHand?: number }) : null;
        if (data?.code === "INSUFFICIENT_STOCK") {
          throw new ConvexError(
            `Only ${data.onHand ?? 0} left of ${line.described.productName ?? "a product"} at the sale's location.`,
          );
        }
        throw e;
      }
    }
    if (line.qty === 0) {
      await ctx.db.delete("saleItems", line.item._id);
    } else {
      await ctx.db.patch("saleItems", line.item._id, {
        qty: line.qty,
        unitPrice: line.unitPrice,
        discountReason: line.discountReason,
        saleDiscountShare: line.saleDiscountShare > 0 ? line.saleDiscountShare : undefined,
      });
    }
  }

  await ctx.db.patch("sales", sale._id, {
    totalAmount: plan.totalAmount,
    linesTotal: plan.linesTotal,
    totalCost: plan.totalCost,
    saleDiscountReason: plan.saleDiscountReason,
    paymentMethod: plan.paymentMethod,
    customerName: plan.customerName,
    createdAt: plan.createdAt,
  });
  const newItems = plan.lines
    .filter((l) => l.qty > 0)
    .map((l) => ({ ...l.item, qty: l.qty, unitPrice: l.unitPrice, saleDiscountShare: l.saleDiscountShare }));
  await applyRollupEvents(
    ctx,
    sale.businessUnitId,
    saleEvents({ locationId: sale.locationId, createdAt: plan.createdAt }, newItems, 1),
  );

  if (sale.customerId) {
    await applySaleTotalChange(ctx, { before: sale, totalAmount: plan.totalAmount, actorId: decider._id });
  }

  const changed = diff(plan.before, plan.after);
  if (changed) {
    await logAudit(ctx, {
      actorId: decider._id,
      action: "update",
      entityTable: "sales",
      entityId: sale._id,
      businessUnitId: sale.businessUnitId,
      before: { number: sale.number, ...changed.before },
      after: { number: sale.number, ...changed.after, approvalId: approval._id },
      ...(approval.reason ? { reason: approval.reason } : {}),
    });
  }
}
