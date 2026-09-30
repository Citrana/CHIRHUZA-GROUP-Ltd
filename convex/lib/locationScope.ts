import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { AuthedQueryCtx } from "./rbac";
import type { Scope } from "./permissions";

/**
 * The location lock shared by location-bound records (payroll entries,
 * withdrawals): an own_location permission ties the record to the caller's
 * own location; all_locations lets them pick any active location of the
 * unit, or none (business-level).
 */

/** The locations a caller may pick, and whether the choice is locked. */
export async function pickableLocations(ctx: AuthedQueryCtx, unitId: Id<"businessUnits">, scope: Scope) {
  if (scope === "own_location") {
    const own = ctx.user.locationId ? await ctx.db.get("locations", ctx.user.locationId) : null;
    return { locked: true, locations: own && own.businessUnitId === unitId && own.active ? [own] : [] };
  }
  const all = await ctx.db
    .query("locations")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unitId))
    .take(500);
  return { locked: false, locations: all.filter((l) => l.active).sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * The location a new record gets: forced to the caller's own for
 * own_location (asking for another is refused), the requested one (active,
 * this unit) or none for all_locations.
 */
export async function locationFor(
  ctx: AuthedQueryCtx,
  unitId: Id<"businessUnits">,
  scope: Scope,
  requested: Id<"locations"> | undefined,
): Promise<Doc<"locations"> | null> {
  let id: Id<"locations"> | undefined = requested;
  if (scope === "own_location") {
    if (!ctx.user.locationId) throw new ConvexError("You have no location - ask an admin to set one.");
    if (requested && requested !== ctx.user.locationId) {
      throw new ConvexError("You can only use your own location.");
    }
    id = ctx.user.locationId;
  }
  if (!id) return null;
  const location = await ctx.db.get("locations", id);
  if (!location || location.businessUnitId !== unitId || !location.active) {
    throw new ConvexError("Choose an active location of this service.");
  }
  return location;
}

/** Active people who can be named on a record (with a role). */
export async function activePeople(ctx: AuthedQueryCtx) {
  return (await ctx.db.query("users").take(1000))
    .filter((u) => u.status === "active" && u.roleId !== null)
    .map((u) => ({ _id: u._id, name: u.name || u.email, email: u.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
