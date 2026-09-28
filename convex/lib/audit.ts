import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Append-only per CLAUDE.md: only ever inserted, never patched or deleted.
 */
export async function logUserAudit(
  ctx: MutationCtx,
  args: { actorId: Id<"users">; action: string; targetUserId: Id<"users"> },
): Promise<void> {
  await ctx.db.insert("auditLogs", args);
}
