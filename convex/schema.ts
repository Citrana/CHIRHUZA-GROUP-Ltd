import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

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
    // Placeholder until roles/permissions land (next prompt) - always null for now.
    roleId: v.union(v.string(), v.null()),
    status: v.union(v.literal("active"), v.literal("blocked")),
    mustChangePassword: v.boolean(),
    // Temporary stand-in for a real permission check until roles/permissions
    // exist. Only ever true for the seeded bootstrap account.
    isSuperAdmin: v.boolean(),
    createdBy: v.union(v.id("users"), v.null()),
  }).index("email", ["email"]),

  // Append-only per CLAUDE.md: never updated or deleted, only inserted.
  auditLogs: defineTable({
    actorId: v.id("users"),
    action: v.string(),
    targetUserId: v.id("users"),
  }).index("by_targetUserId", ["targetUserId"]),
});
