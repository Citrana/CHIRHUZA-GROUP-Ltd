import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import { authedQuery } from "./lib/rbac";
import { auditActionValidator, logAudit } from "./lib/audit";

/**
 * The audit log is append-only (CLAUDE.md). This module deliberately
 * exports NO public mutation, and no function here or anywhere else may
 * patch, replace or delete an `auditLogs` row - a test enforces this.
 */

/**
 * For actions, which have no ctx.db (e.g. users.createUser). Insert only.
 * Mutations call logAudit / ctx.audit directly instead.
 */
export const insertFromActionInternal = internalMutation({
  args: {
    actorId: v.id("users"),
    action: auditActionValidator,
    entityTable: v.string(),
    entityId: v.string(),
    businessUnitId: v.optional(v.id("businessUnits")),
    before: v.optional(v.record(v.string(), v.any())),
    after: v.optional(v.record(v.string(), v.any())),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, entry) => {
    await logAudit(ctx, {
      ...entry,
      entityTable: entry.entityTable as TableNames,
    });
    return null;
  },
});

const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

/**
 * Audit entries, newest first, filtered by any combination of actor,
 * action, entity (table and/or id) and date range (`from`/`to`, UTC ms -
 * the page converts business-time-zone days to these). The most selective
 * filter picks the index; the rest are applied after it.
 */
export const list = authedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    actorId: v.optional(v.id("users")),
    action: v.optional(auditActionValidator),
    entityTable: v.optional(v.string()),
    entityId: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("audit.view");
    const from = args.from ?? 0;
    const to = args.to ?? MAX_TIMESTAMP;
    const table = ctx.db.query("auditLogs");

    const { actorId, action, entityTable, entityId } = args;
    const indexed = actorId
      ? table.withIndex("by_actorId_and_timestamp", (q) =>
          q.eq("actorId", actorId).gte("timestamp", from).lte("timestamp", to),
        )
      : entityTable && entityId
        ? table.withIndex("by_entityTable_and_entityId_and_timestamp", (q) =>
            q
              .eq("entityTable", entityTable)
              .eq("entityId", entityId)
              .gte("timestamp", from)
              .lte("timestamp", to),
          )
        : entityTable
          ? table.withIndex("by_entityTable_and_timestamp", (q) =>
              q
                .eq("entityTable", entityTable)
                .gte("timestamp", from)
                .lte("timestamp", to),
            )
          : action
            ? table.withIndex("by_action_and_timestamp", (q) =>
                q
                  .eq("action", action)
                  .gte("timestamp", from)
                  .lte("timestamp", to),
              )
            : table.withIndex("by_timestamp", (q) =>
                q.gte("timestamp", from).lte("timestamp", to),
              );

    // Predicates the chosen index didn't already cover.
    const result = await indexed
      .filter((q) =>
        q.and(
          action ? q.eq(q.field("action"), action) : true,
          entityTable ? q.eq(q.field("entityTable"), entityTable) : true,
          entityId ? q.eq(q.field("entityId"), entityId) : true,
        ),
      )
      .order("desc")
      .paginate(args.paginationOpts);

    const actorIds = [...new Set(result.page.map((e) => e.actorId))];
    const actors = new Map<Id<"users">, { name: string; email: string }>();
    for (const id of actorIds) {
      const user = await ctx.db.get("users", id);
      if (user) {
        actors.set(id, { name: user.name, email: user.email });
      }
    }

    return {
      ...result,
      page: result.page.map((entry) => ({
        ...entry,
        actorName: actors.get(entry.actorId)?.name ?? null,
        actorEmail: actors.get(entry.actorId)?.email ?? null,
      })),
    };
  },
});

/** Everyone who could appear as an actor, for the actor filter. */
export const listActors = authedQuery({
  args: {},
  handler: async (ctx) => {
    await ctx.requirePermission("audit.view");
    const users = await ctx.db.query("users").take(500);
    return users
      .map((u) => ({ _id: u._id, name: u.name, email: u.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
