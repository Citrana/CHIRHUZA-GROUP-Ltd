import { createAccount } from "@convex-dev/auth/server";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

export const findSuperAdminInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("isSuperAdmin"), true))
      .first();
  },
});

/**
 * Bootstraps the first Super Admin from Convex deployment env vars. Run
 * once via `npx convex run seed:seedSuperAdmin` after setting
 * SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, and SUPER_ADMIN_PASSWORD with
 * `npx convex env set` (not `.env.local` - Convex functions can't read
 * Next.js's client env). No-ops if a Super Admin already exists.
 */
export const seedSuperAdmin = action({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.runQuery(internal.seed.findSuperAdminInternal);
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
        roleId: null,
        status: "active",
        // The admin already knows this password - don't force a rotation.
        mustChangePassword: false,
        isSuperAdmin: true,
        createdBy: null,
      },
    });
    return { created: true };
  },
});
