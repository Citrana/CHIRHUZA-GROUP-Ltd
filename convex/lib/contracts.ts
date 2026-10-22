import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyRollupEvent, applyRollupEvents, contractEvents, driverPaymentEvent } from "./analytics";
import { businessDayOf } from "./time";
import type { ContractPaymentKind, ContractPaymentStatus, TransportPaymentMethod } from "./transport";

/**
 * Transport contract money (CLAUDE.md "Transport"). `applyContractPayment`
 * is the ONLY writer of `contractPayments` (append-only): it inserts the
 * row and updates the contract's amountPaid / paymentStatus and the
 * client's balance, with audit entries, in the caller's mutation.
 * Payments never touch the rollups: revenue counts per contract day.
 */

/** A readable audit snapshot (money fields named so the log formats them). */
export function describeContract(c: Doc<"contracts">) {
  return {
    number: c.number,
    plateNumber: c.plateNumber,
    clientName: c.clientName,
    driverName: c.driverName ?? null,
    startDay: c.startDay,
    endDay: c.endDay,
    days: c.days,
    dayPrice: c.dayRate,
    computedTotal: c.computedTotal,
    totalAmount: c.totalAmount,
    priceChangeReason: c.priceChangeReason ?? null,
    driverDayPrice: c.driverDayRate,
    driverPayTotal: c.driverPayTotal,
    currency: "USD",
    note: c.note ?? null,
  };
}

export function paymentStatusOf(totalAmount: number, amountPaid: number): ContractPaymentStatus {
  return amountPaid >= totalAmount ? "settled" : "open";
}

/** Money received (or, negative, reversed) for a contract. */
export async function applyContractPayment(
  ctx: MutationCtx,
  args: {
    contract: Doc<"contracts">;
    amount: number;
    method: TransportPaymentMethod;
    kind: ContractPaymentKind;
    paidAt: number;
    actorId: Id<"users">;
    note?: string;
    reversesPaymentId?: Id<"contractPayments">;
  },
): Promise<Id<"contractPayments">> {
  const { contract } = args;
  const client = await ctx.db.get("clients", contract.clientId);
  if (!client) throw new ConvexError("Client not found.");
  const amountPaid = contract.amountPaid + args.amount;
  if (amountPaid < 0 || amountPaid > contract.totalAmount) {
    throw new ConvexError("That's more than the client still owes on this contract.");
  }
  const paymentId = await ctx.db.insert("contractPayments", {
    businessUnitId: contract.businessUnitId,
    contractId: contract._id,
    clientId: client._id,
    amount: args.amount,
    currency: "USD",
    method: args.method,
    kind: args.kind,
    ...(args.reversesPaymentId ? { reversesPaymentId: args.reversesPaymentId } : {}),
    paidAt: args.paidAt,
    recordedBy: args.actorId,
    ...(args.note ? { note: args.note } : {}),
  });
  const paymentStatus = paymentStatusOf(contract.totalAmount, amountPaid);
  await ctx.db.patch("contracts", contract._id, { amountPaid, paymentStatus });
  await ctx.db.patch("clients", client._id, { balance: client.balance - args.amount });
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "create",
    entityTable: "contractPayments",
    entityId: paymentId,
    businessUnitId: contract.businessUnitId,
    after: {
      contract: contract.number,
      client: client.name,
      amount: args.amount,
      currency: "USD",
      method: args.method,
      kind: args.kind,
      paidOn: businessDayOf(args.paidAt),
      note: args.note ?? null,
    },
  });
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "update",
    entityTable: "contracts",
    entityId: contract._id,
    businessUnitId: contract.businessUnitId,
    before: { number: contract.number, paidAmount: contract.amountPaid, paymentStatus: contract.paymentStatus, currency: "USD" },
    after: { number: contract.number, paidAmount: amountPaid, paymentStatus, currency: "USD" },
  });
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "update",
    entityTable: "clients",
    entityId: client._id,
    businessUnitId: contract.businessUnitId,
    before: { name: client.name, balanceAmount: client.balance, currency: "USD" },
    after: { name: client.name, balanceAmount: client.balance - args.amount, currency: "USD" },
  });
  return paymentId;
}

/** APPROVAL_HANDLERS.contract_payment_reversal: adds the compensating (negative) payment. */
export async function applyContractPaymentReversal(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const payment = await ctx.db.get("contractPayments", approval.entityId as Id<"contractPayments">);
  if (!payment || payment.kind === "reversal") throw new ConvexError("Payment not found.");
  const already = await ctx.db
    .query("contractPayments")
    .withIndex("by_reversesPaymentId", (q) => q.eq("reversesPaymentId", payment._id))
    .first();
  if (already) throw new ConvexError("This payment was already reversed.");
  const contract = await ctx.db.get("contracts", payment.contractId);
  if (!contract) throw new ConvexError("Contract not found.");
  await applyContractPayment(ctx, {
    contract,
    amount: -payment.amount,
    method: payment.method,
    kind: "reversal",
    paidAt: Date.now(),
    actorId: decider._id,
    reversesPaymentId: payment._id,
    ...(approval.reason ? { note: approval.reason } : {}),
  });
}

/** Whether any client or driver payment (even pending) was ever recorded on the contract. */
export async function hasContractPayments(ctx: MutationCtx, contractId: Id<"contracts">): Promise<boolean> {
  const client = await ctx.db.query("contractPayments").withIndex("by_contractId", (q) => q.eq("contractId", contractId)).first();
  const driver = await ctx.db.query("driverPayments").withIndex("by_contractId", (q) => q.eq("contractId", contractId)).first();
  return client !== null || driver !== null;
}

/** Driver money already committed on a contract: approved + pending (cents). */
export async function driverCommitted(ctx: MutationCtx, contractId: Id<"contracts">): Promise<number> {
  const rows = await ctx.db.query("driverPayments").withIndex("by_contractId", (q) => q.eq("contractId", contractId)).take(500);
  return rows.filter((p) => p.status !== "rejected").reduce((s, p) => s + p.amount, 0);
}

/** The pending driver payment an approval decides (a stale approval is refused). */
async function pendingDriverPaymentFor(ctx: MutationCtx, approval: Doc<"approvals">) {
  const payment = await ctx.db.get("driverPayments", approval.entityId as Id<"driverPayments">);
  if (!payment || payment.approvalId !== approval._id || payment.status !== "pending") {
    throw new ConvexError("This driver payment is no longer waiting for this decision.");
  }
  return payment;
}

/**
 * APPROVAL_HANDLERS.driver_payment: the payment is approved - it adds to
 * the contract's driverPaid and counts as payroll on its paidAt day.
 */
export async function applyDriverPaymentApproval(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const payment = await pendingDriverPaymentFor(ctx, approval);
  const contract = await ctx.db.get("contracts", payment.contractId);
  if (!contract) throw new ConvexError("Contract not found.");
  const driverPaid = contract.driverPaid + payment.amount;
  if (driverPaid > contract.driverPayTotal) throw new ConvexError("That's more than the driver's total for this contract.");
  const decidedAt = Date.now();
  await ctx.db.patch("driverPayments", payment._id, { status: "approved", decidedAt });
  await ctx.db.patch("contracts", contract._id, { driverPaid });
  await applyRollupEvent(ctx, contract.businessUnitId, driverPaymentEvent(payment));
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "driverPayments",
    entityId: payment._id,
    businessUnitId: contract.businessUnitId,
    before: { contract: contract.number, driver: payment.driverName, status: "pending" },
    after: { contract: contract.number, driver: payment.driverName, status: "approved" },
  });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "contracts",
    entityId: contract._id,
    businessUnitId: contract.businessUnitId,
    before: { number: contract.number, driverPaidAmount: contract.driverPaid, currency: "USD" },
    after: { number: contract.number, driverPaidAmount: driverPaid, currency: "USD" },
  });
}

/** APPROVAL_REJECTION_HANDLERS.driver_payment (bookkeeping only). */
export async function applyDriverPaymentRejection(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const payment = await pendingDriverPaymentFor(ctx, approval);
  await ctx.db.patch("driverPayments", payment._id, { status: "rejected", decidedAt: Date.now() });
  await logAudit(ctx, {
    actorId: decider._id,
    action: "update",
    entityTable: "driverPayments",
    entityId: payment._id,
    businessUnitId: payment.businessUnitId,
    before: { driver: payment.driverName, status: "pending" },
    after: { driver: payment.driverName, status: "rejected" },
  });
}

export const CONTRACT_HAS_PAYMENTS = "This contract has payments: it can't be deleted. Edit it instead.";

/**
 * DELETE_HANDLERS.contracts: removes a contract that never had a payment -
 * its revenue leaves the rollups and the client's balance.
 */
export async function deleteApprovedContract(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const contractId = ctx.db.normalizeId("contracts", approval.entityId);
  const contract = contractId ? await ctx.db.get("contracts", contractId) : null;
  if (!contractId || !contract) throw new ConvexError("The contract no longer exists.");
  if (contract.amountPaid !== 0 || contract.driverPaid !== 0 || (await hasContractPayments(ctx, contractId))) {
    throw new ConvexError(CONTRACT_HAS_PAYMENTS);
  }
  await applyRollupEvents(ctx, contract.businessUnitId, contractEvents(contract, -1));
  const client = await ctx.db.get("clients", contract.clientId);
  if (client) {
    await ctx.db.patch("clients", client._id, { balance: client.balance - contract.totalAmount });
    await logAudit(ctx, {
      actorId: decider._id,
      action: "update",
      entityTable: "clients",
      entityId: client._id,
      businessUnitId: contract.businessUnitId,
      before: { name: client.name, balanceAmount: client.balance, currency: "USD" },
      after: { name: client.name, balanceAmount: client.balance - contract.totalAmount, currency: "USD" },
    });
  }
  await ctx.db.delete("contracts", contractId);
  await logAudit(ctx, {
    actorId: decider._id,
    action: "delete",
    entityTable: "contracts",
    entityId: contractId,
    businessUnitId: contract.businessUnitId,
    before: describeContract(contract),
    reason: approval.reason,
  });
}
