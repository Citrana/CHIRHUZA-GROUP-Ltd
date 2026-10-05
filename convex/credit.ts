import { v, ConvexError } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { requestApproval } from "./lib/approvals";
import { logAudit } from "./lib/audit";
import type { Scope } from "./lib/permissions";
import { MAX_BACKDATE_DAYS, saleTimestamp } from "./lib/sales";
import { businessDayOf } from "./lib/time";
import {
  allocateRepayment,
  applySalePayment,
  cleanCustomerName,
  collectionMethodValidator,
  customerNameKey,
  saleBalance,
} from "./lib/credit";

/**
 * Credit (CLAUDE.md "Credit"): who owes what, repayments and corrections.
 * Seeing balances needs sales.view, recording a repayment sales.create,
 * requesting a correction sales.edit.request - each scoped like sales:
 * own_location users only see and act on their own location's sales.
 */

const MAX_OPEN_SALES = 2000;

function inScope(scope: Scope, user: Doc<"users">, locationId: Id<"locations">) {
  return scope === "all_locations" || user.locationId === locationId;
}

/** Customers who owe money (within the caller's scope), largest balance first. */
export const owed = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    const { scope } = await ctx.requirePermission("sales.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const open = (
      await ctx.db
        .query("sales")
        .withIndex("by_businessUnitId_and_creditStatus", (q) => q.eq("businessUnitId", unit._id).eq("creditStatus", "open"))
        .take(MAX_OPEN_SALES)
    ).filter((sale) => sale.customerId && inScope(scope, ctx.user, sale.locationId));
    const byCustomer = new Map<Id<"customers">, { balance: number; openSales: number; oldestSaleAt: number }>();
    for (const sale of open) {
      const row = byCustomer.get(sale.customerId!) ?? { balance: 0, openSales: 0, oldestSaleAt: sale.createdAt };
      row.balance += saleBalance(sale);
      row.openSales += 1;
      row.oldestSaleAt = Math.min(row.oldestSaleAt, sale.createdAt);
      byCustomer.set(sale.customerId!, row);
    }
    const rows = await Promise.all(
      [...byCustomer.entries()].map(async ([customerId, row]) => {
        const customer = await ctx.db.get("customers", customerId);
        return { customerId, name: customer?.name ?? "—", phone: customer?.phone ?? null, ...row };
      }),
    );
    rows.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    return { rows, totalOwed: rows.reduce((s, r) => s + r.balance, 0), currency: "USD" as const };
  },
});

/** One customer: their credit sales and payments (within scope). */
export const customer = authedQuery({
  args: { customerId: v.id("customers") },
  handler: async (ctx, { customerId }) => {
    const { scope } = await ctx.requirePermission("sales.view");
    const customer = await ctx.db.get("customers", customerId);
    if (!customer) throw new ConvexError("Customer not found.");
    const sales = (
      await ctx.db
        .query("sales")
        .withIndex("by_customerId_and_createdAt", (q) => q.eq("customerId", customerId))
        .order("desc")
        .take(200)
    ).filter((sale) => inScope(scope, ctx.user, sale.locationId));
    const payments = (
      await ctx.db
        .query("salePayments")
        .withIndex("by_customerId_and_paidAt", (q) => q.eq("customerId", customerId))
        .order("desc")
        .take(300)
    ).filter((p) => inScope(scope, ctx.user, p.locationId));
    const reversed = new Set(payments.flatMap((p) => (p.reversesPaymentId ? [p.reversesPaymentId] : [])));
    const saleNumber = new Map(sales.map((s) => [s._id, s.number]));
    const pendingReversal = new Set<string>();
    for (const p of payments) {
      if (p.kind === "reversal" || reversed.has(p._id)) continue;
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_entityTable_and_entityId", (q) => q.eq("entityTable", "salePayments").eq("entityId", p._id))
        .take(10);
      if (approvals.some((a) => a.status === "pending")) pendingReversal.add(p._id);
    }
    return {
      _id: customer._id,
      name: customer.name,
      phone: customer.phone ?? null,
      balance: sales.filter((s) => s.creditStatus === "open").reduce((t, s) => t + saleBalance(s), 0),
      currency: "USD" as const,
      sales: await Promise.all(
        sales.map(async (sale) => ({
          _id: sale._id,
          number: sale.number,
          createdAt: sale.createdAt,
          locationName: (await ctx.db.get("locations", sale.locationId))?.name ?? null,
          totalAmount: sale.totalAmount,
          amountPaid: sale.amountPaid ?? 0,
          balance: saleBalance(sale),
          creditStatus: sale.creditStatus ?? null,
        })),
      ),
      payments: await Promise.all(
        payments.map(async (p) => {
          const recorder = await ctx.db.get("users", p.recordedBy);
          return {
            _id: p._id,
            saleNumber: saleNumber.get(p.saleId) ?? null,
            amount: p.amount,
            method: p.method,
            kind: p.kind,
            paidAt: p.paidAt,
            note: p.note ?? null,
            recordedByName: recorder?.name || recorder?.email || null,
            reversed: reversed.has(p._id),
            reversalPending: pendingReversal.has(p._id),
          };
        }),
      ),
      canRecordPayment: ctx.can("sales.create"),
      canRequestReversal: ctx.can("sales.edit.request"),
    };
  },
});

/**
 * Records money a customer paid towards what they owe. It's split over
 * their open credit sales, oldest first (within the caller's scope), and
 * can't be more than they owe there. Dated today or up to
 * MAX_BACKDATE_DAYS back, like sales.
 */
export const recordRepayment = authedMutation({
  args: {
    customerId: v.id("customers"),
    amount: v.number(),
    method: collectionMethodValidator,
    paidOn: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { scope } = await ctx.requirePermission("sales.create");
    const customer = await ctx.db.get("customers", args.customerId);
    if (!customer) throw new ConvexError("Customer not found.");
    if (!Number.isSafeInteger(args.amount) || args.amount < 1) {
      throw new ConvexError("The amount must be a whole number of cents above 0.");
    }
    const note = args.note?.trim() || undefined;
    if (note && note.length > 300) throw new ConvexError("The note is too long.");
    const when = saleTimestamp(args.paidOn, Date.now());
    if ("problem" in when) {
      throw new ConvexError(
        when.problem === "future"
          ? "A payment can't be dated in the future."
          : when.problem === "tooOld"
            ? `Pick today or one of the last ${MAX_BACKDATE_DAYS} days.`
            : "The date must be YYYY-MM-DD.",
      );
    }
    const openSales = (
      await ctx.db
        .query("sales")
        .withIndex("by_customerId_and_createdAt", (q) => q.eq("customerId", customer._id))
        .take(MAX_OPEN_SALES)
    )
      .filter((sale) => sale.creditStatus === "open" && inScope(scope, ctx.user, sale.locationId))
      .map((sale) => ({ sale, balance: saleBalance(sale) }));
    if (openSales.length === 0) throw new ConvexError("This customer owes nothing here.");
    const parts = allocateRepayment(openSales, args.amount);
    for (const part of parts) {
      // Re-read: an earlier part may have touched the same customer.
      const sale = (await ctx.db.get("sales", part.sale.sale._id))!;
      await applySalePayment(ctx, {
        sale,
        amount: part.amount,
        method: args.method,
        kind: "repayment",
        paidAt: when.createdAt,
        actorId: ctx.user._id,
        ...(note ? { note } : {}),
      });
    }
    return { sales: parts.map((p) => p.sale.sale.number) };
  },
});

/**
 * Asks for a wrong payment to be undone (approval type
 * credit_payment_reversal, decided by sales.edit.approve holders - never
 * the requester, except the Super Admin).
 */
export const requestPaymentReversal = authedMutation({
  args: { paymentId: v.id("salePayments"), reason: v.string() },
  handler: async (ctx, { paymentId, reason }) => {
    const payment = await ctx.db.get("salePayments", paymentId);
    if (!payment) throw new ConvexError("Payment not found.");
    await ctx.requirePermission("sales.edit.request", (scope, user) => inScope(scope, user, payment.locationId));
    if (payment.kind === "reversal") throw new ConvexError("A reversal can't be reversed.");
    const cleanReason = reason.trim();
    if (!cleanReason) throw new ConvexError("Say why this payment is wrong.");
    if (cleanReason.length > 300) throw new ConvexError("The reason is too long.");
    const reversed = await ctx.db
      .query("salePayments")
      .withIndex("by_reversesPaymentId", (q) => q.eq("reversesPaymentId", payment._id))
      .first();
    if (reversed) throw new ConvexError("This payment was already reversed.");
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_entityTable_and_entityId", (q) => q.eq("entityTable", "salePayments").eq("entityId", payment._id))
      .take(10);
    if (approvals.some((a) => a.status === "pending")) throw new ConvexError("A correction is already waiting for approval.");
    const [sale, customer] = await Promise.all([ctx.db.get("sales", payment.saleId), ctx.db.get("customers", payment.customerId)]);
    const described = {
      sale: sale?.number ?? null,
      customer: customer?.name ?? null,
      method: payment.method,
      paidOn: businessDayOf(payment.paidAt),
    };
    return await requestApproval(ctx, {
      type: "credit_payment_reversal",
      businessUnitId: payment.businessUnitId,
      locationId: payment.locationId,
      entityTable: "salePayments",
      entityId: payment._id,
      payload: {
        before: { ...described, amount: payment.amount, currency: "USD" },
        after: { ...described, amount: 0, currency: "USD", reversed: true },
      },
      reason: cleanReason,
    });
  },
});

/**
 * One-shot fix for credit sales recorded before credit tracking (a name
 * only): finds or creates the customer by name, marks the sale unpaid and
 * adds it to the customer's balance. Idempotent; handles up to `limit`
 * sales per run - rerun while `more` is true.
 *   npx convex run credit:backfillLegacyCredit
 */
export const backfillLegacyCredit = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 300 }) => {
    let fixed = 0;
    let more = false;
    const units = await ctx.db.query("businessUnits").take(10);
    for (const unit of units) {
      for await (const sale of ctx.db
        .query("sales")
        .withIndex("by_businessUnitId_and_createdAt", (q) => q.eq("businessUnitId", unit._id))) {
        if (sale.paymentMethod !== "credit" || sale.customerId) continue;
        if (fixed >= limit) {
          more = true;
          break;
        }
        const name = cleanCustomerName(sale.customerName ?? "") || "Unknown customer";
        const nameKey = customerNameKey(name);
        let customer = await ctx.db
          .query("customers")
          .withIndex("by_businessUnitId_and_nameKey", (q) => q.eq("businessUnitId", unit._id).eq("nameKey", nameKey))
          .first();
        if (!customer) {
          const customerId = await ctx.db.insert("customers", {
            businessUnitId: unit._id,
            name,
            nameKey,
            searchText: name,
            balance: 0,
            currency: "USD",
            createdBy: sale.soldBy,
            createdAt: Date.now(),
          });
          customer = (await ctx.db.get("customers", customerId))!;
          await logAudit(ctx, {
            actorId: sale.soldBy,
            action: "create",
            entityTable: "customers",
            entityId: customerId,
            businessUnitId: unit._id,
            after: { name, balanceAmount: 0, currency: "USD" },
            reason: "Credit tracking: customer from an earlier credit sale",
          });
        }
        const creditStatus = sale.totalAmount > 0 ? ("open" as const) : ("settled" as const);
        await ctx.db.patch("sales", sale._id, { customerId: customer._id, amountPaid: 0, creditStatus });
        await ctx.db.patch("customers", customer._id, { balance: customer.balance + sale.totalAmount });
        await logAudit(ctx, {
          actorId: sale.soldBy,
          action: "update",
          entityTable: "sales",
          entityId: sale._id,
          businessUnitId: unit._id,
          before: { number: sale.number, customer: null, amountPaid: null, creditStatus: null },
          after: { number: sale.number, customer: customer.name, amountPaid: 0, currency: "USD", creditStatus },
          reason: "Credit tracking: earlier credit sale counted as unpaid",
        });
        fixed++;
      }
      if (more) break;
    }
    return { fixed, more };
  },
});
