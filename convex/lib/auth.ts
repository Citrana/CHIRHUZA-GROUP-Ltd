import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/**
 * Returns the signed-in caller's user document, or `null` if they are not
 * authenticated, don't have a user record, or are blocked. Blocked users are
 * already rejected at sign-in (see convex/auth.ts beforeSessionCreation),
 * but a user can be blocked *after* they already hold a session, so every
 * call site must re-check status here too.
 */
export async function getCurrentUserOrNull(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    return null;
  }
  const user = await ctx.db.get("users", userId);
  if (!user || user.status === "blocked") {
    return null;
  }
  return user;
}

export async function requireCurrentUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) {
    throw new ConvexError("Not authenticated.");
  }
  return user;
}

export async function requireSuperAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users">> {
  const user = await requireCurrentUser(ctx);
  if (!user.isSuperAdmin) {
    throw new ConvexError("Super Admin only.");
  }
  return user;
}

// Action-context variants: @convex-dev/auth's account-mutating helpers
// (createAccount, modifyAccountCredentials, ...) only run from actions,
// which have no ctx.db - so these look the current user up through an
// internal query instead.

export async function requireCurrentUserFromAction(
  ctx: ActionCtx,
): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Not authenticated.");
  }
  const user = await ctx.runQuery(internal.users.getUserByIdInternal, {
    userId,
  });
  if (!user || user.status === "blocked") {
    throw new ConvexError("Not authenticated.");
  }
  return user;
}

export async function requireSuperAdminFromAction(
  ctx: ActionCtx,
): Promise<Doc<"users">> {
  const user = await requireCurrentUserFromAction(ctx);
  if (!user.isSuperAdmin) {
    throw new ConvexError("Super Admin only.");
  }
  return user;
}
