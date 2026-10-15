import { v, ConvexError } from "convex/values";
import { authedMutation } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { applyContractPayment } from "./lib/contracts";
import { businessDayOf } from "./lib/time";
import { MAX_NOTE_LENGTH, checkCents, cleanText, contractBalance, transportPaymentMethodValidator } from "./lib/transport";
import { paidAtFor } from "./contracts";

/**
 * Client payments on transport contracts: any amount up to what's owed, at
 * signing or later, no approval (transport.contracts.manage). A wrong
 * payment is undone only through the approval engine
 * (contract_payment_reversal, decided by the Chief Admin).
 */

export const add = authedMutation({
  args: {
    contractId: v.id("contracts"),
    amount: v.number(),
    method: transportPaymentMethodValidator,
    // The business day it was received (YYYY-MM-DD); missing = today.
    paidOn: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.contracts.manage");
    const contract = await ctx.db.get("contracts", args.contractId);
    if (!contract) throw new ConvexError("Contract not found.");
    const amount = checkCents(args.amount, "The payment");
    if (amount === 0) throw new ConvexError("The payment must be more than 0.");
    if (amount > contractBalance(contract)) throw new ConvexError("That's more than the client still owes on this contract.");
    return await applyContractPayment(ctx, {
      contract,
      amount,
      method: args.method,
      kind: "payment",
      paidAt: paidAtFor(args.paidOn, Date.now()),
      actorId: ctx.user._id,
      note: cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH }),
    });
  },
});

/** Asks for a wrong payment to be undone (the Chief Admin decides). */
export const requestReversal = authedMutation({
  args: { paymentId: v.id("contractPayments"), reason: v.string() },
  handler: async (ctx, { paymentId, reason }) => {
    await ctx.requirePermission("transport.contracts.manage");
    const payment = await ctx.db.get("contractPayments", paymentId);
    if (!payment) throw new ConvexError("Payment not found.");
    if (payment.kind === "reversal") throw new ConvexError("A reversal can't be reversed.");
    const cleanReason = reason.trim();
    if (!cleanReason) throw new ConvexError("Say why this payment is wrong.");
    if (cleanReason.length > 300) throw new ConvexError("The reason is too long.");
    const reversed = await ctx.db
      .query("contractPayments")
      .withIndex("by_reversesPaymentId", (q) => q.eq("reversesPaymentId", payment._id))
      .first();
    if (reversed) throw new ConvexError("This payment was already reversed.");
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_entityTable_and_entityId", (q) => q.eq("entityTable", "contractPayments").eq("entityId", payment._id))
      .take(10);
    if (approvals.some((a) => a.status === "pending")) throw new ConvexError("A correction is already waiting for approval.");
    const [contract, client] = await Promise.all([ctx.db.get("contracts", payment.contractId), ctx.db.get("clients", payment.clientId)]);
    const described = {
      contract: contract?.number ?? null,
      client: client?.name ?? null,
      method: payment.method,
      paidOn: businessDayOf(payment.paidAt),
    };
    return await requestApproval(ctx, {
      type: "contract_payment_reversal",
      businessUnitId: payment.businessUnitId,
      entityTable: "contractPayments",
      entityId: payment._id,
      payload: {
        before: { ...described, amount: payment.amount, currency: "USD" },
        after: { ...described, amount: 0, currency: "USD", reversed: true },
      },
      reason: cleanReason,
    });
  },
});
