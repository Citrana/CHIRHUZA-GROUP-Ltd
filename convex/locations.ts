import { v, ConvexError } from "convex/values";
import { internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/rbac";
import { diff, snapshot } from "./lib/audit";
import { locationTypeValidator } from "./lib/businessUnits";
import { DEFAULT_OPEN_DAYS, cleanOpenDays, openDaysOf } from "./lib/salesDays";

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

/**
 * Every location, including inactive ones, by name. Locations are global:
 * each one serves every service (data there stays per service).
 */
export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("locations.manage");
    const locations = await ctx.db.query("locations").take(500);
    return locations.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Active locations, for user location pickers. */
export const listOptions = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("users.manage");
    const locations = await ctx.db.query("locations").take(1000);
    return locations
      .filter((l) => l.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ _id: l._id, name: l.name, type: l.type }));
  },
});

export const create = authedMutation({
  args: {
    name: v.string(),
    type: locationTypeValidator,
    address: v.string(),
    active: v.boolean(),
    openDays: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("locations.manage");
    const location = {
      name: cleanName(args.name),
      type: args.type,
      address: args.address.trim(),
      active: args.active,
      openDays: cleanOpenDays(args.openDays ?? DEFAULT_OPEN_DAYS),
    };
    const locationId = await ctx.db.insert("locations", location);
    await ctx.audit({
      action: "create",
      entityTable: "locations",
      entityId: locationId,
      after: snapshot(location),
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
    // Weekdays it opens (0 = Sunday); left out = unchanged.
    openDays: v.optional(v.array(v.number())),
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
      openDays: args.openDays ? cleanOpenDays(args.openDays) : openDaysOf(existing).slice(),
    };
    const changes = diff({ ...snapshot(existing, ["name", "type", "address", "active"]), openDays: openDaysOf(existing) }, next);
    if (!changes) {
      return;
    }
    await ctx.db.patch("locations", locationId, next);
    await ctx.audit({
      action: "update",
      entityTable: "locations",
      entityId: locationId,
      ...changes,
    });
  },
});
