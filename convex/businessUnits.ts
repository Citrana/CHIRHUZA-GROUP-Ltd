import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedQuery } from "./lib/rbac";
import { BUSINESS_UNITS, businessUnitKeyValidator } from "./lib/businessUnits";

/**
 * Idempotently inserts any missing business unit. Never overwrites an
 * existing unit's `enabled` flag. Run via `npx convex run
 * seed:seedReferenceData` (which also seeds RBAC).
 */
export const seedBusinessUnits = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const unit of BUSINESS_UNITS) {
      const existing = await ctx.db
        .query("businessUnits")
        .withIndex("by_key", (q) => q.eq("key", unit.key))
        .unique();
      if (!existing) {
        await ctx.db.insert("businessUnits", {
          key: unit.key,
          name: unit.name,
          enabled: unit.enabledByDefault,
        });
      }
    }
    return null;
  },
});

/**
 * All business units in catalog order, for the service picker and shell.
 * Any signed-in user may call this - there is no specific permission
 * because every user needs to pick a service; the authed wrapper still
 * rejects anonymous and blocked callers.
 */
export const list = authedQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("businessUnits"),
      key: businessUnitKeyValidator,
      name: v.string(),
      enabled: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const units = await ctx.db.query("businessUnits").take(20);
    const order = BUSINESS_UNITS.map((u) => u.key);
    return units
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      .map(({ _id, key, name, enabled }) => ({ _id, key, name, enabled }));
  },
});

/**
 * Switches a service on or off (the seed never changes an existing unit's
 * flag). System configuration with no acting user, like the seed:
 *   npx convex run businessUnits:setEnabled '{"key":"fashion","enabled":true}'
 */
export const setEnabled = internalMutation({
  args: { key: businessUnitKeyValidator, enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { key, enabled }) => {
    const unit = await ctx.db
      .query("businessUnits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!unit) throw new Error(`Business unit "${key}" isn't seeded.`);
    if (unit.enabled !== enabled) await ctx.db.patch("businessUnits", unit._id, { enabled });
    return null;
  },
});
