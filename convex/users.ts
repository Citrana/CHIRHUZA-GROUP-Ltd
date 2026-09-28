import { v, ConvexError } from "convex/values";
import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";
import {
  query,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getCurrentUserOrNull,
  requireCurrentUserFromAction,
} from "./lib/auth";
import { authedAction, authedMutation, authedQuery } from "./lib/rbac";
import { logUserAudit } from "./lib/audit";
import { generateStrongPassword } from "./lib/password";
import { SUPER_ADMIN_ROLE_KEY } from "./lib/permissions";

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
        return { ...user, roleKey: role?.key ?? null, roleName: role?.name ?? null };
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
  args: { name: v.string(), email: v.string(), roleId: v.id("roles") },
  handler: async (ctx, { name, email, roleId }) => {
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
    const password = generateStrongPassword();
    await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: password },
      profile: {
        name,
        email,
        roleId,
        status: "active",
        mustChangePassword: true,
        createdBy: ctx.user._id,
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
    if (status === "blocked") {
      await assertNotLastSuperAdmin(ctx, target);
    }
    await ctx.db.patch("users", userId, { status });
    await logUserAudit(ctx, {
      actorId: ctx.user._id,
      action: status === "blocked" ? "user.blocked" : "user.unblocked",
      targetUserId: userId,
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
    await assertNotLastSuperAdmin(ctx, target);
    const previousRole = target.roleId
      ? await ctx.db.get("roles", target.roleId)
      : null;
    await ctx.db.patch("users", userId, { roleId });
    await logUserAudit(ctx, {
      actorId: ctx.user._id,
      action: "user.role_changed",
      targetUserId: userId,
      details: { from: previousRole?.key ?? "none", to: role.key },
    });
  },
});

export const clearMustChangePassword = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await ctx.db.patch("users", userId, { mustChangePassword: false });
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
