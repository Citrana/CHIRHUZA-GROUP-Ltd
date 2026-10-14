import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/rbac";
import { businessUnitKeyValidator } from "./lib/businessUnits";
import { diff } from "./lib/audit";
import { cleanCustomerName, customerNameKey } from "./lib/credit";
import {
  MAX_ADDRESS_LENGTH,
  MAX_CLIENT_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PHONE_LENGTH,
  cleanEmail,
  cleanText,
  clientKindValidator,
  requireFleetUnit,
} from "./lib/transport";

/**
 * Transport clients (convex/lib/transport.ts): companies or people who
 * hire cars, saved once and picked for each contract. One client per name
 * (case and spaces ignored). Viewing needs transport.view; adding and
 * editing transport.contracts.manage. Never deleted.
 */

const MAX_CLIENTS = 1000;

const fieldsValidator = {
  kind: clientKindValidator,
  name: v.string(),
  contactName: v.optional(v.string()),
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  address: v.optional(v.string()),
  note: v.optional(v.string()),
};

type ClientFields = {
  kind: Doc<"clients">["kind"];
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  note?: string;
};

/** Cleaned, checked fields (only the name is required). */
function cleanFields(args: ClientFields) {
  const name = cleanCustomerName(args.name);
  if (!name) throw new ConvexError("The client's name is required.");
  if (name.length > MAX_CLIENT_NAME_LENGTH) throw new ConvexError("The client's name is too long.");
  const fields = {
    kind: args.kind,
    name,
    contactName: cleanText(args.contactName, { label: "Contact person", max: MAX_NAME_LENGTH }),
    phone: cleanText(args.phone, { label: "Phone", max: MAX_PHONE_LENGTH }),
    email: cleanEmail(args.email),
    address: cleanText(args.address, { label: "Address", max: MAX_ADDRESS_LENGTH }),
    note: cleanText(args.note, { label: "Note", max: MAX_NOTE_LENGTH }),
  };
  return {
    ...fields,
    nameKey: customerNameKey(name),
    searchText: [fields.name, fields.contactName, fields.phone, fields.email].filter(Boolean).join(" "),
  };
}

/** Refuses a name another client of the service already has, with that client's id. */
async function checkUniqueName(ctx: QueryCtx, unitId: Id<"businessUnits">, nameKey: string, clientId?: Id<"clients">) {
  const existing = await ctx.db
    .query("clients")
    .withIndex("by_businessUnitId_and_nameKey", (q) => q.eq("businessUnitId", unitId).eq("nameKey", nameKey))
    .first();
  if (existing && existing._id !== clientId) {
    throw new ConvexError({
      code: "DUPLICATE_CLIENT" as const,
      message: `${existing.name} is already a client.`,
      clientId: existing._id,
    });
  }
}

/** An audit snapshot. */
const snapshot = (c: ReturnType<typeof cleanFields> | Doc<"clients">) => ({
  kind: c.kind,
  name: c.name,
  contactName: c.contactName ?? null,
  phone: c.phone ?? null,
  email: c.email ?? null,
  address: c.address ?? null,
  note: c.note ?? null,
});

/** The service's clients, by name. */
export const list = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("transport.view");
    const unit = await requireFleetUnit(ctx, businessUnitKey);
    return await ctx.db
      .query("clients")
      .withIndex("by_businessUnitId_and_nameKey", (q) => q.eq("businessUnitId", unit._id))
      .take(MAX_CLIENTS);
  },
});

/** Clients whose name, contact person, phone or email matches - for the contract form. */
export const search = authedQuery({
  args: { businessUnitKey: businessUnitKeyValidator, query: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("transport.view");
    const unit = await requireFleetUnit(ctx, args.businessUnitKey);
    const query = args.query.trim();
    if (!query) return [];
    const found = await ctx.db
      .query("clients")
      .withSearchIndex("search_text", (q) => q.search("searchText", query).eq("businessUnitId", unit._id))
      .take(10);
    return found.map((c) => ({
      _id: c._id,
      kind: c.kind,
      name: c.name,
      contactName: c.contactName ?? null,
      phone: c.phone ?? null,
      balance: c.balance,
    }));
  },
});

/**
 * Adds a client. A name that's already taken is refused with the existing
 * client's id (code DUPLICATE_CLIENT), so the form can pick them instead.
 */
export const create = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, ...fieldsValidator },
  handler: async (ctx, { businessUnitKey, ...args }) => {
    await ctx.requirePermission("transport.contracts.manage");
    const unit = await requireFleetUnit(ctx, businessUnitKey);
    const fields = cleanFields(args);
    await checkUniqueName(ctx, unit._id, fields.nameKey);
    const clientId = await ctx.db.insert("clients", {
      businessUnitId: unit._id,
      ...fields,
      balance: 0,
      currency: "USD",
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    });
    await ctx.audit({
      action: "create",
      entityTable: "clients",
      entityId: clientId,
      businessUnitId: unit._id,
      after: { ...snapshot(fields), balanceAmount: 0, currency: "USD" },
    });
    return clientId;
  },
});

export const update = authedMutation({
  args: { clientId: v.id("clients"), ...fieldsValidator },
  handler: async (ctx, { clientId, ...args }) => {
    await ctx.requirePermission("transport.contracts.manage");
    const client = await ctx.db.get("clients", clientId);
    if (!client) throw new ConvexError("Client not found.");
    const fields = cleanFields(args);
    await checkUniqueName(ctx, client.businessUnitId, fields.nameKey, client._id);
    const changes = diff(snapshot(client), snapshot(fields));
    if (!changes) return;
    // `undefined` removes a cleared optional field.
    await ctx.db.patch("clients", client._id, fields);
    await ctx.audit({
      action: "update",
      entityTable: "clients",
      entityId: client._id,
      businessUnitId: client.businessUnitId,
      before: { name: client.name, ...changes.before },
      after: { name: fields.name, ...changes.after },
    });
  },
});
