import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { ApprovalType } from "./approvalTypes";
import { addBusinessDays, businessDayOf, businessDayStartUtc } from "./time";

/**
 * Sales (CLAUDE.md "Sales"). A sale takes stock out of one location
 * through applyMovement (type "sale") in the same mutation that records
 * it. Each line keeps the lot's cost at the time (unitCostSnapshot), so
 * margins in the history never change. USD only for now.
 */

export const PAYMENT_METHODS = ["cash", "mobile_money", "credit"] as const;
export const paymentMethodValidator = v.union(
  v.literal("cash"),
  v.literal("mobile_money"),
  v.literal("credit"),
);
export type PaymentMethod = Infer<typeof paymentMethodValidator>;

export const SALE_STATUSES = ["completed", "voided"] as const;
export const saleStatusValidator = v.union(v.literal("completed"), v.literal("voided"));
export type SaleStatus = Infer<typeof saleStatusValidator>;

export const MAX_SALE_LINES = 100;

/**
 * Exchanges (convex/lib/exchanges.ts): products of a cash / mobile money
 * sale can be brought back and swapped for others up to MAX_EXCHANGE_DAYS
 * business days after the sale.
 */
export const MAX_EXCHANGE_DAYS = 30;
export const exchangeDirectionValidator = v.union(v.literal("returned"), v.literal("given"));
export type ExchangeDirection = Infer<typeof exchangeDirectionValidator>;

export type SaleLineProblem = "qty" | "price" | "discountReason";

/**
 * What's wrong with one sale line: a whole quantity from 1, a price in
 * whole cents from 0, and - when the product has a suggested price and the
 * line's price differs from it - a discount reason.
 */
export function saleLineProblems(
  line: { qty: number; unitPrice: number; discountReason?: string },
  suggestedPrice: number | undefined,
): SaleLineProblem[] {
  const problems: SaleLineProblem[] = [];
  if (!Number.isSafeInteger(line.qty) || line.qty < 1) problems.push("qty");
  if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) problems.push("price");
  if (
    suggestedPrice !== undefined &&
    line.unitPrice !== suggestedPrice &&
    !(line.discountReason ?? "").trim()
  ) {
    problems.push("discountReason");
  }
  return problems;
}

/** Margin of a sale line (cents): (price - cost at the time) x quantity. */
export function lineMargin(item: { qty: number; unitPrice: number; unitCostSnapshot: number }): number {
  return (item.unitPrice - item.unitCostSnapshot) * item.qty;
}

/** How many days back a sale may be dated (forgot to record it on the day). */
export const MAX_BACKDATE_DAYS = 7;

/**
 * When a sale sold on business day `soldOn` (YYYY-MM-DD, default today)
 * happened, recorded at `now`. Today: now. An earlier day (up to
 * MAX_BACKDATE_DAYS back): that day at the same Lubumbashi clock time, so
 * it stays inside the chosen day and in entry order. Never in the future.
 */
export function saleTimestamp(
  soldOn: string | undefined,
  now: number,
): { createdAt: number; backdated: boolean } | { problem: "invalid" | "future" | "tooOld" } {
  const today = businessDayOf(now);
  if (soldOn === undefined || soldOn === today) return { createdAt: now, backdated: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(soldOn) || businessDayOf(businessDayStartUtc(soldOn)) !== soldOn) {
    return { problem: "invalid" };
  }
  if (soldOn > today) return { problem: "future" };
  if (soldOn < addBusinessDays(today, -MAX_BACKDATE_DAYS)) return { problem: "tooOld" };
  const clock = now - businessDayStartUtc(today);
  return { createdAt: businessDayStartUtc(soldOn) + clock, backdated: true };
}

/**
 * Takes `qty` units of one product from its lots at a location, oldest lot
 * first (the caller passes them in that order), so a seller sells a
 * product, not a lot. Null when the lots don't hold that many.
 */
export function splitOverLots<T extends { onHand: number }>(
  lots: T[],
  qty: number,
): Array<{ lot: T; qty: number }> | null {
  const parts: Array<{ lot: T; qty: number }> = [];
  let left = qty;
  for (const lot of lots) {
    if (left === 0) break;
    const part = Math.min(left, lot.onHand);
    if (part > 0) parts.push({ lot, qty: part });
    left -= part;
  }
  return left > 0 ? null : parts;
}

/**
 * The part (cents) of a line's whole-sale discount that `qty` more units
 * carry, after `already` were returned. Cumulative rounding, so returning
 * every unit, in any number of exchanges, gives back exactly the line's share.
 */
export function returnedDiscountShare(item: { qty: number; saleDiscountShare?: number }, already: number, qty: number) {
  const share = item.saleDiscountShare ?? 0;
  const upTo = (n: number) => Math.round((share * n) / item.qty);
  return upTo(already + qty) - upTo(already);
}

/** The approval types waiting on a sale (sale_edit, sale_exchange). */
export async function pendingSaleApprovals(ctx: QueryCtx, saleId: Id<"sales">): Promise<Set<ApprovalType>> {
  const approvals = await ctx.db
    .query("approvals")
    .withIndex("by_entityTable_and_entityId", (q) => q.eq("entityTable", "sales").eq("entityId", saleId))
    .order("desc")
    .take(50);
  return new Set(approvals.filter((a) => a.status === "pending").map((a) => a.type));
}

/** Whether products of the sale were already exchanged. */
export async function hasExchange(ctx: QueryCtx, saleId: Id<"sales">): Promise<boolean> {
  return (await ctx.db.query("saleExchanges").withIndex("by_saleId", (q) => q.eq("saleId", saleId)).first()) !== null;
}
