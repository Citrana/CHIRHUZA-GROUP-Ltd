import {
  BadgeCheck,
  Banknote,
  CarFront,
  ChartColumn,
  ClipboardList,
  FileSignature,
  Package,
  Receipt,
  ShoppingCart,
  Wallet,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { BusinessUnitKey } from "../../convex/lib/businessUnits";
import type { PermissionModule } from "../../convex/lib/permissions";

/**
 * The modules of a service's app shell, in menu order. `key` is the URL
 * segment (/[service]/[key]) and the `Modules.<key>` translation key. A
 * module is shown when the user holds any permission in `permissionModule`,
 * or always when `alwaysVisible` (the page itself filters by permission),
 * and only in the listed `services` when it has a list (e.g. stock for the
 * shops, cars for Transport).
 */
/** Home page sections, in order (the admin pages live in the header). */
export const SHELL_MODULE_GROUPS = ["overview", "inventory", "fleet", "money"] as const;

/** The services that sell products from stock. */
const SHOP_SERVICES = ["hair", "fashion"] as const satisfies readonly BusinessUnitKey[];
export type ShellModuleGroup = (typeof SHELL_MODULE_GROUPS)[number];

export const SHELL_MODULES = [
  { key: "analytics", permissionModule: "analytics", icon: ChartColumn, group: "overview" },
  { key: "products", permissionModule: "products", icon: Package, group: "inventory", services: SHOP_SERVICES },
  { key: "requisitions", permissionModule: "requisition", icon: ClipboardList, group: "inventory", services: SHOP_SERVICES },
  { key: "stock", permissionModule: "stock", icon: Warehouse, group: "inventory", services: SHOP_SERVICES },
  { key: "cars", permissionModule: "transport", icon: CarFront, group: "fleet", services: ["transport"] },
  { key: "contracts", permissionModule: "transport", icon: FileSignature, group: "fleet", services: ["transport"] },
  { key: "sales", permissionModule: "sales", icon: ShoppingCart, group: "money", services: SHOP_SERVICES },
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
  /** Only these services show it (missing = every service). */
  services?: readonly BusinessUnitKey[];
  /** The module's page isn't built yet. */
  comingSoon?: boolean;
}>;

export type ShellModule = (typeof SHELL_MODULES)[number];
export type ShellModuleKey = ShellModule["key"];

export function findShellModule(key: string): ShellModule | undefined {
  return SHELL_MODULES.find((m) => m.key === key);
}

/** Whether a service shows this module at all (before permissions). */
export function moduleInService(module: ShellModule, service: BusinessUnitKey): boolean {
  return !("services" in module) || (module.services as readonly BusinessUnitKey[]).includes(service);
}
