"use client";

import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { useRoleText } from "@/components/admin/use-role-text";
import { useCan } from "@/lib/use-can";

export function RolesAdminPanel() {
  const t = useTranslations("Admin.roles");
  const roleText = useRoleText();
  const canManageRoles = useCan("roles.manage");
  const roles = useQuery(api.rbac.listRoles, canManageRoles ? {} : "skip");

  if (canManageRoles === undefined) {
    return null;
  }

  if (!canManageRoles) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-bold text-primary">
        {t("title")}
      </h1>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary text-secondary-foreground">
            <tr>
              <th className="p-3 text-left font-medium">{t("nameHeader")}</th>
              <th className="p-3 text-left font-medium">
                {t("permissionsHeader")}
              </th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {roles?.map((role) => {
              const text = roleText(role);
              return (
                <tr key={role._id} className="border-t border-border">
                  <td className="p-3">
                    <div className="flex items-center gap-2 font-medium">
                      {text.name}
                      {role.locked ? (
                        <Badge variant="secondary">{t("lockedBadge")}</Badge>
                      ) : role.isSystem ? (
                        <Badge variant="outline">{t("systemBadge")}</Badge>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">{text.description}</p>
                  </td>
                  <td className="p-3 whitespace-nowrap text-muted-foreground">
                    {t("permissionCount", { count: role.permissionCount })}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <Link
                      href={`/admin/roles/${role._id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {t("edit")}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
