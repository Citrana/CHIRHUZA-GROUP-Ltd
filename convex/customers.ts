import { v, ConvexError } from "convex/values";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator, requireBusinessUnit } from "./lib/businessUnits";
import { cleanCustomerName, customerNameKey } from "./lib/credit";

/**
 * Customers who buy on credit (CLAUDE.md "Credit"), per service. Sellers
 * (sales.create) find or add them from the sale form; balances are kept
 * by convex/lib/credit.ts.
 */

/** Customers whose name or phone matches, for the sale form's picker. */
export const search = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator, query: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("sales.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const query = args.query.trim();
    if (!query) return [];
    const found = await ctx.db
      .query("customers")
      .withSearchIndex("search_text", (q) => q.search("searchText", query).eq("businessUnitId", unit._id))
      .take(10);
    return found.map((c) => ({ _id: c._id, name: c.name, phone: c.phone ?? null, balance: c.balance }));
  },
});

/**
 * Adds a customer. One customer per name (case and spaces ignored): a
 * duplicate is refused with the existing customer's id, so the form can
 * pick them instead.
 */
export const create = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, name: v.string(), phone: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.requirePermission("sales.create");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const name = cleanCustomerName(args.name);
    if (!name) throw new ConvexError("The customer's name is required.");
    if (name.length > 120) throw new ConvexError("The customer's name is too long.");
    const phone = args.phone?.trim() || undefined;
    if (phone && phone.length > 30) throw new ConvexError("The phone number is too long.");
    const nameKey = customerNameKey(name);
    const existing = await ctx.db
      .query("customers")
      .withIndex("by_businessUnitId_and_nameKey", (q) => q.eq("businessUnitId", unit._id).eq("nameKey", nameKey))
      .first();
    if (existing) {
      throw new ConvexError({
        code: "DUPLICATE_CUSTOMER" as const,
        message: `${existing.name} is already a customer.`,
        customerId: existing._id,
      });
    }
    const customer = {
      businessUnitId: unit._id,
      name,
      nameKey,
      ...(phone ? { phone } : {}),
      searchText: [name, phone].filter(Boolean).join(" "),
      balance: 0,
      currency: "USD" as const,
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    };
    const customerId = await ctx.db.insert("customers", customer);
    await ctx.audit({
      action: "create",
      entityTable: "customers",
      entityId: customerId,
      businessUnitId: unit._id,
      after: { name, phone: phone ?? null, balanceAmount: 0, currency: "USD" },
    });
    return customerId;
  },
});
