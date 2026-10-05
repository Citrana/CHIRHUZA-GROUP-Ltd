import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { businessDayOf } from "./time";

/**
 * Credit sales (CLAUDE.md "Credit"). A credit sale belongs to a customer
 * (`customers`); what was paid at the sale and every later repayment is a
 * `salePayments` row (append-only). The sale's `amountPaid` /
 * `creditStatus` and the customer's `balance` are kept up to date in the
 * same mutation as each payment. A wrong payment is undone by a negative
 * "reversal" row, through the approval engine (credit_payment_reversal).
 * Payments are cash collected, not revenue: they never touch the rollups.
 */

export const creditStatusValidator = v.union(v.literal("open"), v.literal("settled"));
export type CreditStatus = Infer<typeof creditStatusValidator>;

/** How money for a credit sale is received. */
export const COLLECTION_METHODS = ["cash", "mobile_money"] as const;
export const collectionMethodValidator = v.union(v.literal("cash"), v.literal("mobile_money"));
export type CollectionMethod = Infer<typeof collectionMethodValidator>;

export const salePaymentKindValidator = v.union(
  v.literal("at_sale"),
  v.literal("repayment"),
  v.literal("reversal"),
);
export type SalePaymentKind = Infer<typeof salePaymentKindValidator>;

/** A customer's name, trimmed with spaces collapsed. */
export function cleanCustomerName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** The duplicate-check key: the clean name, lowercased. */
export function customerNameKey(name: string): string {
  return cleanCustomerName(name).toLowerCase();
}

/**
 * Splits a whole-sale discount (cents) over lines in proportion to their
 * values, by largest remainder: the shares are whole cents, never exceed a
 * line's value, and add up exactly to the discount.
 */
export function splitDiscount(lineValues: number[], discount: number): number[] {
  const total = lineValues.reduce((s, x) => s + x, 0);
  if (discount <= 0 || total <= 0) return lineValues.map(() => 0);
  if (discount >= total) return [...lineValues];
  const exact = lineValues.map((value) => (value * discount) / total);
  const shares = exact.map(Math.floor);
  let left = discount - shares.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    shares[i]++;
    left--;
  }
  return shares;
}

/**
 * Splits a repayment over open credit sales, oldest first (the caller
 * passes them in that order). Throws when it's more than they owe.
 */
export function allocateRepayment<T extends { balance: number }>(
  openSales: T[],
  amount: number,
): Array<{ sale: T; amount: number }> {
  const owed = openSales.reduce((s, sale) => s + sale.balance, 0);
  if (amount > owed) {
    throw new ConvexError({ code: "OVERPAYMENT" as const, message: "That's more than the customer owes.", owed });
  }
  const parts: Array<{ sale: T; amount: number }> = [];
  let left = amount;
  for (const sale of openSales) {
    if (left === 0) break;
    const part = Math.min(left, sale.balance);
    if (part > 0) parts.push({ sale, amount: part });
    left -= part;
  }
  return parts;
}

/** What a credit sale still owes (cents). */
export function saleBalance(sale: Pick<Doc<"sales">, "totalAmount" | "amountPaid">): number {
  return sale.totalAmount - (sale.amountPaid ?? 0);
}

/**
 * Records money received (or, negative, reversed) for a credit sale: the
 * payment row, the sale's amountPaid / creditStatus and the customer's
 * balance, with audit entries - all in the caller's mutation.
 */
export async function applySalePayment(
  ctx: MutationCtx,
  args: {
    sale: Doc<"sales">;
    amount: number;
    method: CollectionMethod;
    kind: SalePaymentKind;
    paidAt: number;
    actorId: Id<"users">;
    note?: string;
    reversesPaymentId?: Id<"salePayments">;
  },
): Promise<Id<"salePayments">> {
  const { sale } = args;
  if (!sale.customerId) throw new ConvexError("This sale has no customer.");
  const customer = await ctx.db.get("customers", sale.customerId);
  if (!customer) throw new ConvexError("Customer not found.");
  const amountPaid = (sale.amountPaid ?? 0) + args.amount;
  if (amountPaid < 0 || amountPaid > sale.totalAmount) {
    throw new ConvexError("This payment doesn't fit the sale's balance.");
  }
  const paymentId = await ctx.db.insert("salePayments", {
    businessUnitId: sale.businessUnitId,
    saleId: sale._id,
    customerId: customer._id,
    locationId: sale.locationId,
    amount: args.amount,
    currency: "USD",
    method: args.method,
    kind: args.kind,
    ...(args.reversesPaymentId ? { reversesPaymentId: args.reversesPaymentId } : {}),
    paidAt: args.paidAt,
    recordedBy: args.actorId,
    ...(args.note ? { note: args.note } : {}),
  });
  const creditStatus: CreditStatus = amountPaid >= sale.totalAmount ? "settled" : "open";
  await ctx.db.patch("sales", sale._id, { amountPaid, creditStatus });
  await ctx.db.patch("customers", customer._id, { balance: customer.balance - args.amount });
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "create",
    entityTable: "salePayments",
    entityId: paymentId,
    businessUnitId: sale.businessUnitId,
    after: {
      sale: sale.number,
      customer: customer.name,
      kind: args.kind,
      method: args.method,
      amount: args.amount,
      currency: "USD",
      paidOn: businessDayOf(args.paidAt),
      note: args.note ?? null,
    },
  });
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "update",
    entityTable: "sales",
    entityId: sale._id,
    businessUnitId: sale.businessUnitId,
    before: { number: sale.number, amountPaid: sale.amountPaid ?? 0, balanceAmount: saleBalance(sale), currency: "USD", creditStatus: sale.creditStatus ?? null },
    after: { number: sale.number, amountPaid, balanceAmount: sale.totalAmount - amountPaid, currency: "USD", creditStatus },
  });
  return paymentId;
}

/** APPROVAL_HANDLERS.credit_payment_reversal: undoes a wrong payment. */
export async function applyCreditPaymentReversal(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
) {
  const payment = await ctx.db.get("salePayments", approval.entityId as Id<"salePayments">);
  if (!payment || payment.kind === "reversal") throw new ConvexError("Payment not found.");
  const already = await ctx.db
    .query("salePayments")
    .withIndex("by_reversesPaymentId", (q) => q.eq("reversesPaymentId", payment._id))
    .first();
  if (already) throw new ConvexError("This payment was already reversed.");
  const sale = await ctx.db.get("sales", payment.saleId);
  if (!sale) throw new ConvexError("Sale not found.");
  await applySalePayment(ctx, {
    sale,
    amount: -payment.amount,
    method: payment.method,
    kind: "reversal",
    paidAt: Date.now(),
    actorId: decider._id,
    reversesPaymentId: payment._id,
    ...(approval.reason ? { note: approval.reason } : {}),
  });
}
