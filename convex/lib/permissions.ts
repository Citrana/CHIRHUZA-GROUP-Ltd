import { v, type Infer } from "convex/values";

/**
 * The permission catalog - the single source of truth for every permission
 * key in the system. Seeded idempotently into the `permissions` table by
 * `rbac:seedRbac`. Add new keys here; never check a key that isn't listed.
 *
 * `description` is an English fallback only - the UI translates keys via
 * `Permissions.<key>` in messages/*.json.
 */
export const PERMISSIONS = [
  { key: "sales.view", module: "sales", description: "View sales" },
  { key: "sales.create", module: "sales", description: "Record sales" },
  { key: "sales.edit.request", module: "sales", description: "Request an edit to a sale" },
  { key: "sales.edit.approve", module: "sales", description: "Approve sale edits" },

  { key: "expenses.view", module: "expenses", description: "View expenses" },
  { key: "expenses.request", module: "expenses", description: "Request an expense" },
  { key: "expenses.approve", module: "expenses", description: "Approve expenses" },

  { key: "payroll.view", module: "payroll", description: "View payroll" },
  { key: "payroll.create", module: "payroll", description: "Create payroll entries" },
  { key: "payroll.approve", module: "payroll", description: "Approve payroll" },

  { key: "stock.view", module: "stock", description: "View stock" },
  { key: "stock.create", module: "stock", description: "Create purchase batches" },
  { key: "stock.set_price", module: "stock", description: "Set prices on purchase" },
  { key: "stock.distribute", module: "stock", description: "Distribute stock to locations" },
  { key: "stock.approve", module: "stock", description: "Approve stock movements" },

  { key: "products.view", module: "products", description: "View products" },
  { key: "products.manage", module: "products", description: "Create and edit products" },

  { key: "requisition.view", module: "requisition", description: "View requisitions" },
  { key: "requisition.create", module: "requisition", description: "Create requisitions" },
  { key: "requisition.approve", module: "requisition", description: "Approve requisitions" },

  { key: "withdrawals.view", module: "withdrawals", description: "View withdrawals" },
  { key: "withdrawals.request", module: "withdrawals", description: "Request a withdrawal" },
  { key: "withdrawals.approve", module: "withdrawals", description: "Approve withdrawals" },

  { key: "deletes.approve", module: "approvals", description: "Approve delete requests" },
  { key: "approvals.view_all", module: "approvals", description: "View all approval requests" },

  { key: "analytics.view", module: "analytics", description: "View analytics" },

  { key: "users.manage", module: "admin", description: "Manage users" },
  { key: "roles.manage", module: "admin", description: "Manage roles and permissions" },
  { key: "locations.manage", module: "admin", description: "Manage locations" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
export type PermissionModule = (typeof PERMISSIONS)[number]["module"];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map(
  (p) => p.key,
);

export function isPermissionKey(key: string): key is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(key);
}

export const scopeValidator = v.union(
  v.literal("own_location"),
  v.literal("all_locations"),
);
export type Scope = Infer<typeof scopeValidator>;

export const SUPER_ADMIN_ROLE_KEY = "super_admin";

type RoleSeed = {
  key: string;
  name: string;
  description: string;
  permissions: ReadonlyArray<readonly [PermissionKey, Scope]>;
};

const all = (keys: PermissionKey[]) =>
  keys.map((k) => [k, "all_locations"] as const);

const VIEW_KEYS = PERMISSION_KEYS.filter((k) => k.endsWith(".view"));

/** Granted to every role (Sales Agent at own_location, others all_locations). */
const PRODUCTS_AND_WITHDRAWALS: PermissionKey[] = [
  "products.view",
  "products.manage",
  "withdrawals.view",
  "withdrawals.request",
  "withdrawals.approve",
];

/**
 * The six system roles and their *default* permission sets. Defaults are
 * applied only when a role is first created by the seed, so a Super Admin's
 * later edits survive re-seeding. The exception is Super Admin itself,
 * which is locked and always re-synced to hold every permission.
 */
export const SYSTEM_ROLES: readonly RoleSeed[] = [
  {
    key: SUPER_ADMIN_ROLE_KEY,
    name: "Super Admin",
    description: "Full access, including user and role management.",
    permissions: all([...PERMISSION_KEYS]),
  },
  {
    key: "chief_admin",
    name: "Chief Admin",
    description: "Oversees analytics and approves edits, stock, payroll, expenses and requisitions.",
    permissions: all([
      ...VIEW_KEYS,
      "analytics.view",
      "sales.edit.approve",
      "stock.approve",
      "payroll.create",
      "payroll.approve",
      "expenses.approve",
      "requisition.approve",
      "deletes.approve",
      "approvals.view_all",
      ...PRODUCTS_AND_WITHDRAWALS,
    ]),
  },
  {
    key: "manager_admin",
    name: "Manager Admin",
    description: "Distributes stock, with basic viewing.",
    permissions: all([
      "stock.distribute",
      "stock.view",
      "sales.view",
      "requisition.view",
      ...PRODUCTS_AND_WITHDRAWALS,
    ]),
  },
  {
    key: "chief_sales_admin",
    name: "Chief Sales Admin",
    description: "Records sales, approves sale edits and raises requisitions.",
    permissions: all([
      "sales.view",
      "sales.create",
      "sales.edit.approve",
      "requisition.create",
      ...PRODUCTS_AND_WITHDRAWALS,
    ]),
  },
  {
    key: "chief_inventory_admin",
    name: "Chief Inventory Admin",
    description: "Creates purchase batches and sets prices on purchase.",
    permissions: all([
      "stock.view",
      "stock.create",
      "stock.set_price",
      ...PRODUCTS_AND_WITHDRAWALS,
    ]),
  },
  {
    key: "sales_agent",
    name: "Sales Agent",
    description: "Records sales and requests edits at their own location.",
    permissions: [
      ["sales.create", "own_location"],
      ["sales.edit.request", "own_location"],
      ...PRODUCTS_AND_WITHDRAWALS.map((k) => [k, "own_location"] as const),
    ],
  },
];

type SeedStep = {
  key: string;
  grants: ReadonlyArray<readonly [roleKey: string, PermissionKey, Scope]>;
};

/**
 * One-shot changes to *existing* roles' grants. SYSTEM_ROLES defaults only
 * apply when a role is first created, so a new default that must also reach
 * roles already in a database goes here. `rbac:seedRbac` applies each step
 * once and records its key in `appliedSeedSteps`, so an admin's later edit
 * (e.g. revoking one of these grants) survives re-seeding.
 * Never edit or reorder an applied step - add a new one.
 */
export const SEED_STEPS: readonly SeedStep[] = [
  {
    key: "2026-09-products-withdrawals-all-roles",
    grants: SYSTEM_ROLES.filter((r) => r.key !== SUPER_ADMIN_ROLE_KEY).flatMap(
      (role) =>
        PRODUCTS_AND_WITHDRAWALS.map((permissionKey) => {
          const scope: Scope =
            role.key === "sales_agent" ? "own_location" : "all_locations";
          return [role.key, permissionKey, scope] as const;
        }),
    ),
  },
];
