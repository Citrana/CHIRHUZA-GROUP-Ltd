import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Append-only per CLAUDE.md: only ever inserted, never patched or deleted.
 */
export async function logAudit(
  ctx: MutationCtx,
  args: {
    actorId: Id<"users">;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, string>;
  },
): Promise<void> {
  await ctx.db.insert("auditLogs", args);
}

export async function logUserAudit(
  ctx: MutationCtx,
  args: {
    actorId: Id<"users">;
    action: string;
    targetUserId: Id<"users">;
    details?: Record<string, string>;
  },
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    ...args,
    entityType: "users",
    entityId: args.targetUserId,
  });
}
