import { v, ConvexError } from "convex/values";
import { authedMutation } from "./lib/rbac";
import { requestApproval } from "./lib/approvals";
import { driverCommitted } from "./lib/contracts";
import { businessDayOf } from "./lib/time";
import { MAX_NOTE_LENGTH, checkCents, cleanText, transportPaymentMethodValidator } from "./lib/transport";
import { paidAtFor } from "./contracts";

/**
 * Driver payments on transport contracts, in installments
 * (transport.driver_pay.request). Each waits for the Chief Admin's
 * approval (driver_payment); pending + approved never exceed the
 * contract's driver total. Approved ones count as payroll.
 */
export const request = authedMutation({
  args: {
    contractId: v.id("contracts"),
    amount: v.number(),
    method: transportPaymentMethodValidator,
    // The business day the driver is paid (YYYY-MM-DD); missing = today.
    paidOn: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.driver_pay.request");
    const contract = await ctx.db.get("contracts", args.contractId);
    if (!contract) throw new ConvexError("Contract not found.");
    if (!contract.driverName) throw new ConvexError("This contract has no driver.");
    const amount = checkCents(args.amount, "The payment");
    if (amount === 0) throw new ConvexError("The payment must be more than 0.");
    const committed = await driverCommitted(ctx, contract._id);
    if (committed + amount > contract.driverPayTotal) {
      throw new ConvexError("That's more than the driver is still owed on this contract (counting payments waiting for approval).");
    }
    const paidAt = paidAtFor(args.paidOn, Date.now());
    const note = cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH });
    const paymentId = await ctx.db.insert("driverPayments", {
      businessUnitId: contract.businessUnitId,
      contractId: contract._id,
      ...(contract.driverId ? { driverId: contract.driverId } : {}),
      driverName: contract.driverName,
      amount,
      currency: "USD",
      method: args.method,
      paidAt,
      note,
      status: "pending",
      requestedBy: ctx.user._id,
      createdAt: Date.now(),
    });
    const summary = {
      contract: contract.number,
      driver: contract.driverName,
      amount,
      currency: "USD",
      method: args.method,
      paidOn: businessDayOf(paidAt),
      note: note ?? null,
    };
    const approvalId = await requestApproval(ctx, {
      type: "driver_payment",
      businessUnitId: contract.businessUnitId,
      entityTable: "driverPayments",
      entityId: paymentId,
      payload: { after: summary },
    });
    await ctx.db.patch("driverPayments", paymentId, { approvalId });
    await ctx.audit({
      action: "create",
      entityTable: "driverPayments",
      entityId: paymentId,
      businessUnitId: contract.businessUnitId,
      after: { ...summary, status: "pending" },
    });
    return paymentId;
  },
});
