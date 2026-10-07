import { v, ConvexError } from "convex/values";
import { createAccount, invalidateSessions, modifyAccountCredentials } from "@convex-dev/auth/server";
import {
  query,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getCurrentUserOrNull,
  requireCurrentUserFromAction,
} from "./lib/auth";
import {
  authedAction,
  authedMutation,
  authedQuery,
  roleRequiresLocation,
} from "./lib/rbac";
import { logAudit } from "./lib/audit";
import { generateStrongPassword } from "./lib/password";
import { SUPER_ADMIN_ROLE_KEY } from "./lib/permissions";

const LOCATION_REQUIRED =
  "This role requires a location. Assign the user a location first.";

async function getActiveLocation(
  ctx: MutationCtx,
  locationId: Id<"locations">,
): Promise<Doc<"locations">> {
  const location = await ctx.db.get("locations", locationId);
  if (!location || !location.active) {
    throw new ConvexError("Location not found or inactive.");
  }
  return location;
}

/**
 * Refuses to take the Super Admin role away from (or block) the last
 * active Super Admin - otherwise nobody could manage users or roles.
 */
async function assertNotLastSuperAdmin(ctx: MutationCtx, target: Doc<"users">) {
  if (target.roleId === null || target.status !== "active") {
    return;
  }
  const role = await ctx.db.get("roles", target.roleId);
  if (role?.key !== SUPER_ADMIN_ROLE_KEY) {
    return;
  }
  const activeSuperAdmins = await ctx.db
    .query("users")
    .withIndex("by_roleId", (q) => q.eq("roleId", role._id))
    .filter((q) => q.eq(q.field("status"), "active"))
    .take(2);
  if (activeSuperAdmins.length <= 1) {
    throw new ConvexError("This is the last active Super Admin.");
  }
}

/** Used across the app to know who's signed in (or null). */
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return await getCurrentUserOrNull(ctx);
  },
});

export const getUserByIdInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db.get("users", userId);
  },
});

/** Lists every user (with their role) for the user management screen. */
export const listUsers = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("users.manage");
    const users = await ctx.db.query("users").order("desc").take(200);
    return await Promise.all(
      users.map(async (user) => {
        const role = user.roleId ? await ctx.db.get("roles", user.roleId) : null;
        const location = user.locationId
          ? await ctx.db.get("locations", user.locationId)
          : null;
        return {
          ...user,
          roleKey: role?.key ?? null,
          roleName: role?.name ?? null,
          locationName: location?.name ?? null,
        };
      }),
    );
  },
});

/**
 * Super Admin creates a user with a system-generated password. The password
 * is returned once, directly in this action's response - it is never stored
 * in plaintext (Convex Auth's authAccounts table stores only a hash) and
 * can never be retrieved again after this call returns.
 */
export const createUser = authedAction({
  args: {
    name: v.string(),
    email: v.string(),
    roleId: v.id("roles"),
    locationId: v.optional(v.id("locations")),
  },
  handler: async (ctx, { name, email, roleId, locationId }) => {
    await ctx.requirePermission("users.manage");
    const role = await ctx.runQuery(internal.rbac.getRoleByIdInternal, {
      roleId,
    });
    if (!role) {
      throw new ConvexError("Role not found.");
    }
    // Minting a Super Admin is a privilege grant, not just user management.
    if (role.key === SUPER_ADMIN_ROLE_KEY) {
      await ctx.requirePermission("roles.manage");
    }
    const location: Doc<"locations"> | null =
      locationId !== undefined
        ? await ctx.runQuery(internal.locations.getByIdInternal, { locationId })
        : null;
    if (locationId !== undefined) {
      if (!location || !location.active) {
        throw new ConvexError("Location not found or inactive.");
      }
    } else if (
      await ctx.runQuery(internal.rbac.roleRequiresLocationInternal, { roleId })
    ) {
      throw new ConvexError(LOCATION_REQUIRED);
    }
    const password = generateStrongPassword();
    const { user } = await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: password },
      profile: {
        name,
        email,
        roleId,
        ...(locationId !== undefined ? { locationId } : {}),
        status: "active",
        mustChangePassword: true,
        createdBy: ctx.user._id,
      },
    });
    // Actions can't write the DB directly, so the entry goes through an
    // internal mutation. Never log the password.
    await ctx.runMutation(internal.auditLogs.insertFromActionInternal, {
      actorId: ctx.user._id,
      action: "create",
      entityTable: "users",
      entityId: user._id,
      after: {
        name,
        email,
        roleId,
        role: role.key,
        locationId: locationId ?? null,
        location: location?.name ?? null,
        status: "active",
        mustChangePassword: true,
      },
    });
    return { password };
  },
});

export const setUserStatus = authedMutation({
  args: {
    userId: v.id("users"),
    status: v.union(v.literal("active"), v.literal("blocked")),
  },
  handler: async (ctx, { userId, status }) => {
    await ctx.requirePermission("users.manage");
    if (userId === ctx.user._id) {
      throw new ConvexError("You cannot change your own status.");
    }
    const target = await ctx.db.get("users", userId);
    if (!target) {
      throw new ConvexError("User not found.");
    }
    if (target.status === status) {
      return;
    }
    if (status === "blocked") {
      await assertNotLastSuperAdmin(ctx, target);
    }
    await ctx.db.patch("users", userId, { status });
    await ctx.audit({
      action: "update",
      entityTable: "users",
      entityId: userId,
      before: { status: target.status },
      after: { status },
    });
  },
});

/**
 * Assigns a user's role. Gated by roles.manage (not just users.manage)
 * because it grants privileges. Takes effect on the user's next call.
 */
export const setUserRole = authedMutation({
  args: { userId: v.id("users"), roleId: v.id("roles") },
  handler: async (ctx, { userId, roleId }) => {
    await ctx.requirePermission("roles.manage");
    if (userId === ctx.user._id) {
      throw new ConvexError("You cannot change your own role.");
    }
    const target = await ctx.db.get("users", userId);
    if (!target) {
      throw new ConvexError("User not found.");
    }
    const role = await ctx.db.get("roles", roleId);
    if (!role) {
      throw new ConvexError("Role not found.");
    }
    if (target.roleId === roleId) {
      return;
    }
    if (!target.locationId && (await roleRequiresLocation(ctx, roleId))) {
      throw new ConvexError(LOCATION_REQUIRED);
    }
    await assertNotLastSuperAdmin(ctx, target);
    const previousRole = target.roleId
      ? await ctx.db.get("roles", target.roleId)
      : null;
    await ctx.db.patch("users", userId, { roleId });
    await ctx.audit({
      action: "update",
      entityTable: "users",
      entityId: userId,
      before: { roleId: target.roleId, role: previousRole?.key ?? null },
      after: { roleId, role: role.key },
    });
  },
});

/**
 * Sets or clears (`null`) a user's location. It can't be cleared while the
 * user's role requires one.
 */
export const setUserLocation = authedMutation({
  args: {
    userId: v.id("users"),
    locationId: v.union(v.id("locations"), v.null()),
  },
  handler: async (ctx, { userId, locationId }) => {
    await ctx.requirePermission("users.manage");
    const target = await ctx.db.get("users", userId);
    if (!target) {
      throw new ConvexError("User not found.");
    }
    if ((target.locationId ?? null) === locationId) {
      return;
    }
    let next: Doc<"locations"> | null = null;
    if (locationId === null) {
      if (target.roleId && (await roleRequiresLocation(ctx, target.roleId))) {
        throw new ConvexError(LOCATION_REQUIRED);
      }
    } else {
      next = await getActiveLocation(ctx, locationId);
    }
    const previous = target.locationId
      ? await ctx.db.get("locations", target.locationId)
      : null;
    await ctx.db.patch("users", userId, {
      locationId: locationId ?? undefined,
    });
    const businessUnitId = (next ?? previous)?.businessUnitId;
    await ctx.audit({
      action: "update",
      entityTable: "users",
      entityId: userId,
      ...(businessUnitId ? { businessUnitId } : {}),
      before: {
        locationId: target.locationId ?? null,
        location: previous?.name ?? null,
      },
      after: { locationId, location: next?.name ?? null },
    });
  },
});

/**
 * Runs after a successful password change: clears the forced-change flag
 * and audits the change (the user is their own actor). The password is
 * never logged - only the fact that it changed.
 */
export const clearMustChangePassword = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get("users", userId);
    if (!user) {
      return;
    }
    await ctx.db.patch("users", userId, { mustChangePassword: false });
    await logAudit(ctx, {
      actorId: userId,
      action: "update",
      entityTable: "users",
      entityId: userId,
      before: { mustChangePassword: user.mustChangePassword },
      after: { mustChangePassword: false, passwordChanged: true },
    });
  },
});

/**
 * The signed-in user changes their own password, clearing the forced
 * password-change flag. Runs as an action because modifyAccountCredentials
 * requires action context.
 */
export const changePassword = action({
  args: { newPassword: v.string() },
  handler: async (ctx, { newPassword }) => {
    const user = await requireCurrentUserFromAction(ctx);
    if (newPassword.length < 8) {
      throw new ConvexError("Password must be at least 8 characters.");
    }
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: user.email, secret: newPassword },
    });
    await ctx.runMutation(internal.users.clearMustChangePassword, {
      userId: user._id,
    });
  },
});

/**
 * Records a password reset done by an admin: forces the user to choose a
 * new password at their next sign-in, and audits it (actor = the admin).
 * The password itself is never logged.
 */
export const markPasswordReset = internalMutation({
  args: { userId: v.id("users"), actorId: v.id("users") },
  handler: async (ctx, { userId, actorId }) => {
    const user = await ctx.db.get("users", userId);
    if (!user) return;
    await ctx.db.patch("users", userId, { mustChangePassword: true });
    await logAudit(ctx, {
      actorId,
      action: "update",
      entityTable: "users",
      entityId: userId,
      before: { name: user.name, email: user.email, mustChangePassword: user.mustChangePassword },
      after: { name: user.name, email: user.email, mustChangePassword: true, passwordReset: true },
    });
  },
});

/**
 * The Super Admin resets a user who forgot their password: a new strong
 * password replaces the old one, every session of that user is signed out,
 * and they must choose their own password at the next sign-in. The new
 * password is returned once (to share in person or by phone) and never
 * stored in plaintext. Not for your own account (use changePassword);
 * resetting a Super Admin also needs roles.manage.
 */
export const resetPassword = authedAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await ctx.requirePermission("users.manage");
    if (userId === ctx.user._id) {
      throw new ConvexError("Use Change password for your own account.");
    }
    const target: Doc<"users"> | null = await ctx.runQuery(internal.users.getUserByIdInternal, { userId });
    if (!target) {
      throw new ConvexError("User not found.");
    }
    if (target.roleId) {
      const role = await ctx.runQuery(internal.rbac.getRoleByIdInternal, { roleId: target.roleId });
      // Taking over a Super Admin's account is a privilege matter.
      if (role?.key === SUPER_ADMIN_ROLE_KEY) {
        await ctx.requirePermission("roles.manage");
      }
    }
    const password = generateStrongPassword();
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: target.email, secret: password },
    });
    // The old password and every open session stop working now.
    await invalidateSessions(ctx, { userId: target._id });
    await ctx.runMutation(internal.users.markPasswordReset, { userId: target._id, actorId: ctx.user._id });
    return { password };
  },
});
