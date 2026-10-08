import {
  BadgeCheck,
  Banknote,
  ChartColumn,
  ClipboardList,
  Package,
  Receipt,
  ShoppingCart,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { PermissionModule } from "../../convex/lib/permissions";

/**
 * The modules of a service's app shell, in menu order. `key` is the URL
 * segment (/[service]/[key]) and the `Modules.<key>` translation key. A
 * module is shown when the user holds any permission in `permissionModule`,
 * or always when `alwaysVisible` (the page itself filters by permission).
 */
/** Home page sections, in order (the admin pages live in the header). */
export const SHELL_MODULE_GROUPS = ["overview", "inventory", "money"] as const;
export type ShellModuleGroup = (typeof SHELL_MODULE_GROUPS)[number];

export const SHELL_MODULES = [
  { key: "analytics", permissionModule: "analytics", icon: ChartColumn, group: "overview" },
  { key: "products", permissionModule: "products", icon: Package, group: "inventory" },
  { key: "requisitions", permissionModule: "requisition", icon: ClipboardList, group: "inventory" },
  { key: "stock", permissionModule: "stock", icon: Warehouse, group: "inventory" },
  { key: "sales", permissionModule: "sales", icon: ShoppingCart, group: "money" },
  // Not built yet: Home shows it dimmed, "Not available yet".
  { key: "expenses", permissionModule: "expenses", icon: Receipt, group: "money", comingSoon: true },
  { key: "payroll", permissionModule: "payroll", icon: Wallet, group: "money" },
  { key: "withdrawals", permissionModule: "withdrawals", icon: Banknote, group: "money" },
  // Everyone may have requests to track; the list shows each user only
  // what they may see.
  {
    key: "approvals",
    permissionModule: "approvals",
    icon: BadgeCheck,
    group: "overview",
    alwaysVisible: true,
  },
] as const satisfies ReadonlyArray<{
  key: string;
  permissionModule: PermissionModule;
  icon: LucideIcon;
  /** The Home page section the module's card sits in. */
  group: ShellModuleGroup;
  alwaysVisible?: boolean;
  /** The module's page isn't built yet. */
  comingSoon?: boolean;
}>;

export type ShellModule = (typeof SHELL_MODULES)[number];
export type ShellModuleKey = ShellModule["key"];

export function findShellModule(key: string): ShellModule | undefined {
  return SHELL_MODULES.find((m) => m.key === key);
}
