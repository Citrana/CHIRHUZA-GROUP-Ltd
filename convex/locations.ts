import { v, ConvexError } from "convex/values";
import { internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/rbac";
import { logAudit } from "./lib/audit";
import { locationTypeValidator } from "./lib/businessUnits";

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ConvexError("Location name is required.");
  }
  if (trimmed.length > 100) {
    throw new ConvexError("Location name is too long.");
  }
  return trimmed;
}

export const getByIdInternal = internalQuery({
  args: { locationId: v.id("locations") },
  handler: async (ctx, { locationId }) => {
    return await ctx.db.get("locations", locationId);
  },
});

/** Locations of one business unit, including inactive ones, by name. */
export const list = authedQuery({
  args: { businessUnitId: v.id("businessUnits") },
  handler: async (ctx, { businessUnitId }) => {
    await ctx.requirePermission("locations.manage");
    const locations = await ctx.db
      .query("locations")
      .withIndex("by_businessUnitId", (q) =>
        q.eq("businessUnitId", businessUnitId),
      )
      .take(500);
    return locations.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Active locations across all business units, for user location pickers. */
export const listOptions = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("users.manage");
    const units = await ctx.db.query("businessUnits").take(20);
    const unitKeys = new Map(units.map((u) => [u._id, u.key]));
    const locations = await ctx.db.query("locations").take(1000);
    return locations
      .filter((l) => l.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({
        _id: l._id,
        name: l.name,
        type: l.type,
        businessUnitKey: unitKeys.get(l.businessUnitId) ?? null,
      }));
  },
});

export const create = authedMutation({
  args: {
    businessUnitId: v.id("businessUnits"),
    name: v.string(),
    type: locationTypeValidator,
    address: v.string(),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("locations.manage");
    const unit = await ctx.db.get("businessUnits", args.businessUnitId);
    if (!unit) {
      throw new ConvexError("Business unit not found.");
    }
    const location = {
      businessUnitId: args.businessUnitId,
      name: cleanName(args.name),
      type: args.type,
      address: args.address.trim(),
      active: args.active,
    };
    const locationId = await ctx.db.insert("locations", location);
    await logAudit(ctx, {
      actorId: ctx.user._id,
      action: "location.created",
      entityType: "locations",
      entityId: locationId,
      details: {
        businessUnit: unit.key,
        name: location.name,
        type: location.type,
        address: location.address,
        active: String(location.active),
      },
    });
    return locationId;
  },
});

/** Edits a location. Deactivate (active: false) instead of deleting. */
export const update = authedMutation({
  args: {
    locationId: v.id("locations"),
    name: v.string(),
    type: locationTypeValidator,
    address: v.string(),
    active: v.boolean(),
  },
  handler: async (ctx, { locationId, ...args }) => {
    await ctx.requirePermission("locations.manage");
    const existing = await ctx.db.get("locations", locationId);
    if (!existing) {
      throw new ConvexError("Location not found.");
    }
    const next = {
      name: cleanName(args.name),
      type: args.type,
      address: args.address.trim(),
      active: args.active,
    };
    const details: Record<string, string> = {};
    for (const field of ["name", "type", "address", "active"] as const) {
      const before = existing[field];
      if (before !== next[field]) {
        details[field] = `${String(before)} -> ${String(next[field])}`;
      }
    }
    if (Object.keys(details).length === 0) {
      return;
    }
    await ctx.db.patch("locations", locationId, next);
    await logAudit(ctx, {
      actorId: ctx.user._id,
      action: "location.updated",
      entityType: "locations",
      entityId: locationId,
      details,
    });
  },
});
