import { createAccount } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const findSuperAdminInternal = internalQuery({
  args: { superAdminRoleId: v.id("roles") },
  handler: async (ctx, { superAdminRoleId }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_roleId", (q) => q.eq("roleId", superAdminRoleId))
      .first();
  },
});

/**
 * Bootstraps the first Super Admin from Convex deployment env vars. Run
 * once via `npx convex run seed:seedSuperAdmin` after setting
 * SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, and SUPER_ADMIN_PASSWORD with
 * `npx convex env set` (not `.env.local` - Convex functions can't read
 * Next.js's client env). Seeds roles/permissions first (idempotent), then
 * no-ops if a user with the Super Admin role already exists.
 */
export const seedSuperAdmin = action({
  args: {},
  handler: async (ctx) => {
    const { superAdminRoleId }: { superAdminRoleId: Id<"roles"> } =
      await ctx.runMutation(internal.rbac.seedRbac, {});
    const existing: Doc<"users"> | null = await ctx.runQuery(
      internal.seed.findSuperAdminInternal,
      { superAdminRoleId },
    );
    if (existing) {
      return { created: false, message: "A Super Admin already exists." };
    }

    const name = process.env.SUPER_ADMIN_NAME;
    const email = process.env.SUPER_ADMIN_EMAIL;
    const password = process.env.SUPER_ADMIN_PASSWORD;
    if (!name || !email || !password) {
      throw new Error(
        "Missing SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, or SUPER_ADMIN_PASSWORD. " +
          "Set them with `npx convex env set <NAME> <VALUE>` first.",
      );
    }

    await createAccount(ctx, {
      provider: "password",
      account: { id: email, secret: password },
      profile: {
        name,
        email,
        roleId: superAdminRoleId,
        status: "active",
        // The admin already knows this password - don't force a rotation.
        mustChangePassword: false,
        createdBy: null,
      },
    });
    return { created: true };
  },
});
