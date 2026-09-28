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
 * module is shown when the user holds any permission in `permissionModule`.
 */
export const SHELL_MODULES = [
  { key: "analytics", permissionModule: "analytics", icon: ChartColumn },
  { key: "products", permissionModule: "products", icon: Package },
  { key: "requisitions", permissionModule: "requisition", icon: ClipboardList },
  { key: "stock", permissionModule: "stock", icon: Warehouse },
  { key: "sales", permissionModule: "sales", icon: ShoppingCart },
  { key: "expenses", permissionModule: "expenses", icon: Receipt },
  { key: "payroll", permissionModule: "payroll", icon: Wallet },
  { key: "withdrawals", permissionModule: "withdrawals", icon: Banknote },
  { key: "approvals", permissionModule: "approvals", icon: BadgeCheck },
] as const satisfies ReadonlyArray<{
  key: string;
  permissionModule: PermissionModule;
  icon: LucideIcon;
}>;

export type ShellModule = (typeof SHELL_MODULES)[number];
export type ShellModuleKey = ShellModule["key"];

export function findShellModule(key: string): ShellModule | undefined {
  return SHELL_MODULES.find((m) => m.key === key);
}
