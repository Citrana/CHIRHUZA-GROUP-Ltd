import { v, ConvexError } from "convex/values";
import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";
import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  getCurrentUserOrNull,
  requireSuperAdmin,
  requireSuperAdminFromAction,
  requireCurrentUserFromAction,
} from "./lib/auth";
import { logUserAudit } from "./lib/audit";
import { generateStrongPassword } from "./lib/password";

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

/** Super Admin only - lists every user for the user management screen. */
export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    return await ctx.db.query("users").order("desc").take(200);
  },
});

/**
 * Super Admin creates a user with a system-generated password. The password
 * is returned once, directly in this action's response - it is never stored
 * in plaintext (Convex Auth's authAccounts table stores only a hash) and
 * can never be retrieved again after this call returns.
 */
export const createUser = action({
  args: { name: v.string(), email: v.string() },
  handler: async (ctx, { name, email }) => {
    const admin = await requireSuperAdminFromAction(ctx);
    const password = generateStrongPassword();
    await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: password },
      profile: {
        name,
        email,
        roleId: null,
        status: "active",
        mustChangePassword: true,
        isSuperAdmin: false,
        createdBy: admin._id,
      },
    });
    return { password };
  },
});

export const setUserStatus = mutation({
  args: {
    userId: v.id("users"),
    status: v.union(v.literal("active"), v.literal("blocked")),
  },
  handler: async (ctx, { userId, status }) => {
    const admin = await requireSuperAdmin(ctx);
    if (userId === admin._id) {
      throw new ConvexError("You cannot change your own status.");
    }
    const target = await ctx.db.get("users", userId);
    if (!target) {
      throw new ConvexError("User not found.");
    }
    await ctx.db.patch("users", userId, { status });
    await logUserAudit(ctx, {
      actorId: admin._id,
      action: status === "blocked" ? "user.blocked" : "user.unblocked",
      targetUserId: userId,
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
