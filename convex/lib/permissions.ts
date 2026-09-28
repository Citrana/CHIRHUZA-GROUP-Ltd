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

  { key: "requisition.view", module: "requisition", description: "View requisitions" },
  { key: "requisition.create", module: "requisition", description: "Create requisitions" },
  { key: "requisition.approve", module: "requisition", description: "Approve requisitions" },

  { key: "deletes.approve", module: "approvals", description: "Approve delete requests" },
  { key: "approvals.view_all", module: "approvals", description: "View all approval requests" },

  { key: "analytics.view", module: "analytics", description: "View analytics" },

  { key: "users.manage", module: "admin", description: "Manage users" },
  { key: "roles.manage", module: "admin", description: "Manage roles and permissions" },
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
    ]),
  },
  {
    key: "manager_admin",
    name: "Manager Admin",
    description: "Distributes stock, with basic viewing.",
    permissions: all(["stock.distribute", "stock.view", "sales.view", "requisition.view"]),
  },
  {
    key: "chief_sales_admin",
    name: "Chief Sales Admin",
    description: "Records sales, approves sale edits and raises requisitions.",
    permissions: all(["sales.view", "sales.create", "sales.edit.approve", "requisition.create"]),
  },
  {
    key: "chief_inventory_admin",
    name: "Chief Inventory Admin",
    description: "Creates purchase batches and sets prices on purchase.",
    permissions: all(["stock.view", "stock.create", "stock.set_price"]),
  },
  {
    key: "sales_agent",
    name: "Sales Agent",
    description: "Records sales and requests edits at their own location.",
    permissions: [
      ["sales.create", "own_location"],
      ["sales.edit.request", "own_location"],
    ],
  },
];
