import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { scopeValidator } from "./lib/permissions";

// See CLAUDE.md for the permanent rules that apply to every business table:
// - businessUnitId (hair | fashion | housing | transport) unless truly global
// - money as integer minor units + a currency field, never floats
// - deletes go through an approval request, never immediate
// - every add/update/delete writes an audit log entry
export default defineSchema({
  ...authTables,

  users: defineTable({
    name: v.string(),
    email: v.string(),
    // User -> Role -> Permissions. There is no direct user-to-permission link.
    // null means "no role", i.e. no permissions at all.
    roleId: v.union(v.id("roles"), v.null()),
    status: v.union(v.literal("active"), v.literal("blocked")),
    mustChangePassword: v.boolean(),
    // DEPRECATED - replaced by the Super Admin role. No longer read or
    // written; kept optional only so pre-RBAC documents still validate.
    // `rbac:seedRbac` backfills such users onto the Super Admin role.
    isSuperAdmin: v.optional(v.boolean()),
    createdBy: v.union(v.id("users"), v.null()),
  })
    .index("email", ["email"])
    .index("by_roleId", ["roleId"]),

  // RBAC tables are global (no businessUnitId): roles and permissions are
  // shared system configuration, not data owned by one business unit.
  roles: defineTable({
    // Stable slug (e.g. "super_admin") used by the seed and for UI translations.
    key: v.string(),
    name: v.string(),
    description: v.string(),
    isSystem: v.boolean(),
  }).index("by_key", ["key"]),

  permissions: defineTable({
    key: v.string(),
    description: v.string(),
    module: v.string(),
  })
    .index("by_key", ["key"])
    .index("by_module", ["module"]),

  rolePermissions: defineTable({
    roleId: v.id("roles"),
    permissionId: v.id("permissions"),
    scope: scopeValidator,
  })
    .index("by_roleId_and_permissionId", ["roleId", "permissionId"])
    .index("by_permissionId", ["permissionId"]),

  // Append-only per CLAUDE.md: never updated or deleted, only inserted.
  auditLogs: defineTable({
    actorId: v.id("users"),
    action: v.string(),
    // Legacy field from before entityType/entityId existed; still written
    // for user-targeted actions.
    targetUserId: v.optional(v.id("users")),
    entityType: v.optional(v.string()),
    entityId: v.optional(v.string()),
    details: v.optional(v.record(v.string(), v.string())),
  })
    .index("by_targetUserId", ["targetUserId"])
    .index("by_entityType_and_entityId", ["entityType", "entityId"]),
});
