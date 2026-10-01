import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { AuthedQueryCtx } from "./rbac";
import type { Scope } from "./permissions";

/**
 * Locations are global - every location serves every service. The
 * location lock for location-bound records (sales, payroll, withdrawals):
 * an own_location permission ties the record to the caller's own location;
 * all_locations lets them pick any active location, or none
 * (business-level).
 */

/** Every active location, by name. */
export async function activeLocations(ctx: QueryCtx): Promise<Doc<"locations">[]> {
  const all = await ctx.db.query("locations").take(500);
  return all.filter((l) => l.active).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Locations a list can be filtered by: all of them (inactive ones too, for
 * history), or just the caller's own for own_location viewers.
 */
export async function filterableLocations(ctx: AuthedQueryCtx, scope: Scope) {
  if (scope === "own_location") {
    const own = ctx.user.locationId ? await ctx.db.get("locations", ctx.user.locationId) : null;
    return { locked: true, locations: own ? [{ _id: own._id, name: own.name }] : [] };
  }
  const all = await ctx.db.query("locations").take(500);
  return {
    locked: false,
    locations: all.map((l) => ({ _id: l._id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The caller's own location, if they have one and it's active. */
export async function ownActiveLocation(ctx: AuthedQueryCtx): Promise<Doc<"locations"> | null> {
  const own = ctx.user.locationId ? await ctx.db.get("locations", ctx.user.locationId) : null;
  return own && own.active ? own : null;
}

/** The locations a caller may pick, and whether the choice is locked. */
export async function pickableLocations(ctx: AuthedQueryCtx, scope: Scope) {
  if (scope === "own_location") {
    const own = await ownActiveLocation(ctx);
    return { locked: true, locations: own ? [own] : [] };
  }
  return { locked: false, locations: await activeLocations(ctx) };
}

/**
 * The location a new record gets: forced to the caller's own for
 * own_location (asking for another is refused), the requested one (must be
 * active) or none for all_locations.
 */
export async function locationFor(
  ctx: AuthedQueryCtx,
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
  if (!location || !location.active) {
    throw new ConvexError("Choose an active location.");
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
