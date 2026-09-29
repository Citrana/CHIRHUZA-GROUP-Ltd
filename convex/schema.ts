import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { scopeValidator } from "./lib/permissions";
import { auditActionValidator } from "./lib/audit";
import {
  requisitionItemResolutionValidator,
  requisitionStatusValidator,
} from "./lib/requisitions";
import {
  productCategoryValidator,
  productStatusValidator,
  productUnitValidator,
} from "./lib/products";
import {
  approvalStatusValidator,
  approvalTypeValidator,
} from "./lib/approvalTypes";
import {
  businessUnitKeyValidator,
  locationTypeValidator,
} from "./lib/businessUnits";

// See CLAUDE.md for the permanent rules that apply to every business table:
// - businessUnitId: v.id("businessUnits") (hair | fashion | housing |
//   transport) unless truly global
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
    // The user's own location. Missing = none. Required (enforced in
    // convex/users.ts) when their role has any own_location permission.
    locationId: v.optional(v.id("locations")),
  })
    .index("email", ["email"])
    .index("by_roleId", ["roleId"]),

  // Global reference data: the four services. Seeded by
  // businessUnits:seedBusinessUnits; every business table points here via
  // `businessUnitId`.
  businessUnits: defineTable({
    key: businessUnitKeyValidator,
    name: v.string(),
    enabled: v.boolean(),
  }).index("by_key", ["key"]),

  // Shops and warehouses. Never deleted - retire with `active: false`.
  locations: defineTable({
    businessUnitId: v.id("businessUnits"),
    name: v.string(),
    type: locationTypeValidator,
    address: v.string(),
    active: v.boolean(),
  }).index("by_businessUnitId", ["businessUnitId"]),

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

  // Keys of one-shot seed steps already applied (see SEED_STEPS in
  // convex/lib/permissions.ts). Global; only ever inserted.
  appliedSeedSteps: defineTable({
    key: v.string(),
  }).index("by_key", ["key"]),

  // Product catalogue (convex/lib/products.ts). No prices here - prices are
  // set at purchase time. Deleted only via an approved `delete` approval.
  products: defineTable({
    businessUnitId: v.id("businessUnits"),
    name: v.string(),
    // Auto-generated, unique, never reused (see skuCounters).
    sku: v.string(),
    category: productCategoryValidator,
    unit: productUnitValidator,
    brand: v.optional(v.string()),
    texture: v.optional(v.string()),
    // One of the business unit's productLengths.
    lengthInches: v.optional(v.number()),
    colourId: v.optional(v.id("productColours")),
    status: productStatusValidator,
    createdBy: v.id("users"),
    // Set when a pending product is confirmed (or at creation by a confirmer).
    confirmedBy: v.optional(v.id("users")),
    confirmedAt: v.optional(v.number()),
    // Lowercased name/sku/brand/texture/category, for search.
    searchText: v.string(),
  })
    .index("by_sku", ["sku"])
    .index("by_businessUnitId_and_name", ["businessUnitId", "name"])
    .index("by_businessUnitId_and_status_and_name", ["businessUnitId", "status", "name"])
    .index("by_businessUnitId_and_category_and_name", ["businessUnitId", "category", "name"])
    // For "is this length / colour used by any product?" in product settings.
    .index("by_businessUnitId_and_lengthInches", ["businessUnitId", "lengthInches"])
    .index("by_colourId", ["colourId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["businessUnitId", "status", "category"],
    }),

  // Per-business-unit product settings. Deactivated, never deleted, so
  // products that use a value keep it.
  productLengths: defineTable({
    businessUnitId: v.id("businessUnits"),
    inches: v.number(),
    active: v.boolean(),
  }).index("by_businessUnitId_and_inches", ["businessUnitId", "inches"]),

  productColours: defineTable({
    businessUnitId: v.id("businessUnits"),
    name: v.string(),
    active: v.boolean(),
  }).index("by_businessUnitId_and_name", ["businessUnitId", "name"]),

  // Next SKU sequence number per business unit.
  skuCounters: defineTable({
    businessUnitId: v.id("businessUnits"),
    next: v.number(),
  }).index("by_businessUnitId", ["businessUnitId"]),

  // Requisitions (convex/lib/requisitions.ts): a location's request for
  // stock, approved through the approval engine (type "requisition").
  requisitions: defineTable({
    businessUnitId: v.id("businessUnits"),
    locationId: v.id("locations"),
    // e.g. REQ-00001, per business unit (numberSequences).
    number: v.string(),
    note: v.optional(v.string()),
    status: requisitionStatusValidator,
    createdBy: v.id("users"),
    // UTC ms of the latest submission.
    submittedAt: v.optional(v.number()),
    // The latest submission's approval.
    approvalId: v.optional(v.id("approvals")),
  })
    .index("by_businessUnitId", ["businessUnitId"])
    .index("by_businessUnitId_and_status", ["businessUnitId", "status"])
    .index("by_businessUnitId_and_createdBy", ["businessUnitId", "createdBy"]),

  // One line per product per requisition.
  requisitionItems: defineTable({
    requisitionId: v.id("requisitions"),
    productId: v.id("products"),
    qtyRequested: v.number(),
    note: v.optional(v.string()),
    // Set by purchasing; "pending" until then.
    resolution: requisitionItemResolutionValidator,
  })
    .index("by_requisitionId_and_productId", ["requisitionId", "productId"])
    .index("by_productId", ["productId"]),

  // Per-business-unit document number sequences (e.g. key "requisition").
  numberSequences: defineTable({
    businessUnitId: v.id("businessUnits"),
    key: v.string(),
    next: v.number(),
  }).index("by_businessUnitId_and_key", ["businessUnitId", "key"]),

  // The generic approval engine (convex/lib/approvals.ts). Created only via
  // requestApproval; status moves pending -> approved/rejected exactly once,
  // via approvals.decideApproval. Every request and decision is audited.
  approvals: defineTable({
    businessUnitId: v.id("businessUnits"),
    // Set when the change belongs to one location (scopes own_location deciders).
    locationId: v.optional(v.id("locations")),
    type: approvalTypeValidator,
    entityTable: v.string(),
    entityId: v.string(),
    // The proposed change: `{ before?, after?, ...handler data }`. Never secrets.
    payload: v.any(),
    reason: v.optional(v.string()),
    status: approvalStatusValidator,
    requestedBy: v.id("users"),
    decidedBy: v.optional(v.id("users")),
    // UTC ms.
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    // A PermissionKey the decider must hold.
    requiredPermission: v.string(),
  })
    .index("by_businessUnitId", ["businessUnitId"])
    .index("by_businessUnitId_and_status", ["businessUnitId", "status"])
    .index("by_businessUnitId_and_requestedBy", ["businessUnitId", "requestedBy"])
    .index("by_businessUnitId_and_type", ["businessUnitId", "type"])
    .index("by_entityTable_and_entityId", ["entityTable", "entityId"]),

  // Append-only per CLAUDE.md: never updated or deleted, only inserted -
  // write it only through logAudit / ctx.audit (convex/lib/audit.ts).
  auditLogs: defineTable({
    actorId: v.id("users"),
    action: auditActionValidator,
    entityTable: v.string(),
    entityId: v.string(),
    businessUnitId: v.optional(v.id("businessUnits")),
    // JSON snapshots: the full record for create/delete, only the changed
    // fields for update. Never secrets.
    before: v.optional(v.record(v.string(), v.any())),
    after: v.optional(v.record(v.string(), v.any())),
    reason: v.optional(v.string()),
    // UTC ms.
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_actorId_and_timestamp", ["actorId", "timestamp"])
    .index("by_action_and_timestamp", ["action", "timestamp"])
    .index("by_entityTable_and_timestamp", ["entityTable", "timestamp"])
    .index("by_entityTable_and_entityId_and_timestamp", [
      "entityTable",
      "entityId",
      "timestamp",
    ]),
});
