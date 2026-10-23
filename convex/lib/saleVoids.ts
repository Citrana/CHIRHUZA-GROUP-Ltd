import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logAudit } from "./audit";
import { applyMovement, getOrCreateHolder } from "./inventory";
import { applyRollupEvents, saleEvents } from "./analytics";
import { saleItemsOf } from "./saleEdits";

/**
 * Voiding a sale recorded by mistake: its products go back to the sale's
 * location (same lots, `return` movements), its revenue / cost / margin
 * leave the rollups, and the sale stays as history with status "voided"
 * and the reason. A credit sale also leaves the customer's balance; it
 * must be unpaid (a payment is reversed first). Lines are kept.
 */
export async function voidSale(
  ctx: MutationCtx,
  sale: Doc<"sales">,
  args: { actorId: Id<"users">; reason: string; approvalId?: Id<"approvals"> },
) {
  if (sale.status !== "completed") throw new ConvexError(`${sale.number} is already cancelled.`);
  if ((sale.amountPaid ?? 0) > 0) throw new ConvexError(`Reverse the payments on ${sale.number} first.`);
  const items = await saleItemsOf(ctx, sale._id);

  await applyRollupEvents(ctx, sale.businessUnitId, saleEvents(sale, items, -1));
  const location = await getOrCreateHolder(ctx, sale.businessUnitId, { type: "location", refId: sale.locationId });
  for (const item of items) {
    await applyMovement(ctx, {
      type: "return",
      inventoryBatchId: item.inventoryBatchId,
      toHolderId: location,
      qty: item.qty,
      refTable: "sales",
      refId: sale._id,
      actorId: args.actorId,
    });
  }

  const voidedAt = Date.now();
  await ctx.db.patch("sales", sale._id, {
    status: "voided",
    voidReason: args.reason,
    voidedAt,
    voidedBy: args.actorId,
    // No longer owed: out of the credit lists.
    creditStatus: undefined,
  });
  await logAudit(ctx, {
    actorId: args.actorId,
    action: "update",
    entityTable: "sales",
    entityId: sale._id,
    businessUnitId: sale.businessUnitId,
    before: { number: sale.number, status: sale.status, creditStatus: sale.creditStatus ?? null },
    after: {
      number: sale.number,
      status: "voided",
      totalAmount: sale.totalAmount,
      currency: "USD",
      ...(args.approvalId ? { approvalId: args.approvalId } : {}),
    },
    reason: args.reason,
  });

  if (sale.customerId) {
    const customer = await ctx.db.get("customers", sale.customerId);
    if (!customer) throw new ConvexError("Customer not found.");
    const balance = customer.balance - sale.totalAmount;
    await ctx.db.patch("customers", customer._id, { balance });
    await logAudit(ctx, {
      actorId: args.actorId,
      action: "update",
      entityTable: "customers",
      entityId: customer._id,
      businessUnitId: sale.businessUnitId,
      before: { name: customer.name, balanceAmount: customer.balance, currency: "USD" },
      after: { name: customer.name, balanceAmount: balance, currency: "USD", sale: sale.number },
      reason: args.reason,
    });
  }
}

/**
 * APPROVAL_HANDLERS.credit_cancel: voids a customer's credit sales that
 * were recorded by mistake. Every sale must still be as it was asked for
 * (open, unpaid, same total) - otherwise it throws and the approval stays
 * pending, to be rejected and asked again.
 */
export async function applyCreditCancel(ctx: MutationCtx, approval: Doc<"approvals">, decider: Doc<"users">) {
  const { sales } = approval.payload as { sales: Array<{ saleId: Id<"sales">; number: string; totalAmount: number }> };
  const current = await Promise.all(sales.map((s) => ctx.db.get("sales", s.saleId)));
  sales.forEach((requested, i) => {
    const sale = current[i];
    if (
      !sale ||
      sale.status !== "completed" ||
      sale.creditStatus !== "open" ||
      (sale.amountPaid ?? 0) > 0 ||
      sale.totalAmount !== requested.totalAmount
    ) {
      throw new ConvexError(`${requested.number} changed since this was asked for: reject it and ask again.`);
    }
  });
  for (const sale of current) {
    await voidSale(ctx, sale!, { actorId: decider._id, reason: approval.reason ?? "", approvalId: approval._id });
  }
}
