"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { PermissionKey, PermissionModule, Scope } from "../../../convex/lib/permissions";
import { Link } from "@/i18n/navigation";
import { NativeSelect } from "@/components/ui/native-select";
import { useRoleText } from "@/components/admin/use-role-text";
import { useCan } from "@/lib/use-can";

/**
 * Section names for every permission module. Typed against the catalog's
 * modules, so adding a module without its name here is a compile error.
 */
function useModuleLabels(): Record<PermissionModule, string> {
  const t = useTranslations("PermissionModules");
  return {
    sales: t("sales"),
    expenses: t("expenses"),
    payroll: t("payroll"),
    stock: t("stock"),
    requisition: t("requisition"),
    approvals: t("approvals"),
    analytics: t("analytics"),
    admin: t("admin"),
    products: t("products"),
    withdrawals: t("withdrawals"),
  };
}

/**
 * Grant/revoke each permission and pick its scope. Every change is saved
 * immediately and takes effect on the role's users' next call.
 */
export function RolePermissionsEditor({ roleId }: { roleId: string }) {
  const t = useTranslations("Admin.roles");
  const tPermission = useTranslations("Permissions");
  const moduleLabels = useModuleLabels();
  const roleText = useRoleText();
  const canManageRoles = useCan("roles.manage");
  const data = useQuery(
    api.rbac.getRole,
    canManageRoles ? { roleId } : "skip",
  );
  const setRolePermission = useMutation(api.rbac.setRolePermission);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState(false);

  if (canManageRoles === undefined) {
    return null;
  }
  if (!canManageRoles) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }
  if (data === undefined) {
    return null;
  }

  const back = (
    <Link
      href="/admin/roles"
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      ← {t("back")}
    </Link>
  );

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
      </div>
    );
  }

  const { role, locked, modules } = data;
  const text = roleText(role);

  async function save(permissionKey: string, scope: Scope | null) {
    setPending((prev) => new Set(prev).add(permissionKey));
    setError(false);
    try {
      await setRolePermission({ roleId: role._id, permissionKey, scope });
    } catch {
      setError(true);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(permissionKey);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {back}
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">
          {text.name}
        </h1>
        <p className="text-sm text-muted-foreground">{text.description}</p>
      </div>

      {locked ? (
        <p className="rounded-lg border border-border bg-muted p-3 text-sm">
          {t("lockedNote")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive">{t("saveError")}</p>
      ) : null}

      {modules.map(({ module, permissions }) => (
        <section key={module} className="flex flex-col gap-2">
          <h2 className="font-heading text-lg font-semibold">
            {moduleLabels[module as PermissionModule] ?? module}
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary text-secondary-foreground">
                <tr>
                  <th className="p-3 text-left font-medium">
                    {t("permissionHeader")}
                  </th>
                  <th className="w-24 p-3 text-center font-medium">
                    {t("grantedHeader")}
                  </th>
                  <th className="w-44 p-3 text-left font-medium">
                    {t("scopeHeader")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {permissions.map((permission) => {
                  const disabled = locked || pending.has(permission.key);
                  const inputId = `perm-${permission.key}`;
                  return (
                    <tr key={permission.key} className="border-t border-border">
                      <td className="p-3">
                        <label htmlFor={inputId}>
                          {tPermission(permission.key as PermissionKey)}
                        </label>
                        <p className="font-mono text-xs text-muted-foreground">
                          {permission.key}
                        </p>
                      </td>
                      <td className="p-3 text-center">
                        <input
                          id={inputId}
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={permission.scope !== null}
                          disabled={disabled}
                          onChange={(event) =>
                            // New grants default to the narrower scope.
                            save(
                              permission.key,
                              event.target.checked ? "own_location" : null,
                            )
                          }
                        />
                      </td>
                      <td className="p-3">
                        {permission.scope !== null ? (
                          <NativeSelect
                            aria-label={t("scopeHeader")}
                            value={permission.scope}
                            disabled={disabled}
                            onChange={(event) =>
                              save(permission.key, event.target.value as Scope)
                            }
                          >
                            <option value="own_location">{t("scopeOwn")}</option>
                            <option value="all_locations">{t("scopeAll")}</option>
                          </NativeSelect>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
