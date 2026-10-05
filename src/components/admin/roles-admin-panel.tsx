"use client";

import { useQuery } from "convex/react";
import type { DataTableColumn } from "@/components/data-table/features";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import { Badge } from "@/components/ui/badge";
import { useRoleText } from "@/components/admin/use-role-text";
import { useCan } from "@/lib/use-can";

type RoleRow = FunctionReturnType<typeof api.rbac.listRoles>[number];

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

  const columns: DataTableColumn<RoleRow>[] = [
    {
      id: "name",
      // Sort and search by the translated name the user actually sees.
      accessorFn: (role) => roleText(role).name,
      header: t("nameHeader"),
      enableSorting: true,
      cell: ({ row }) => {
        const role = row.original;
        const text = roleText(role);
        return (
          <div>
            <div className="flex items-center gap-2 font-medium">
              {text.name}
              {role.locked ? (
                <Badge variant="secondary">{t("lockedBadge")}</Badge>
              ) : role.isSystem ? (
                <Badge variant="outline">{t("systemBadge")}</Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground">{text.description}</p>
          </div>
        );
      },
    },
    {
      accessorKey: "permissionCount",
      header: t("permissionsHeader"),
      enableSorting: true,
      cell: ({ row }) =>
        t("permissionCount", { count: row.original.permissionCount }),
      meta: { className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "edit",
      header: () => <span className="sr-only">{t("edit")}</span>,
      cell: ({ row }) => (
        <Link
          href={`/admin/roles/${row.original._id}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("edit")}
        </Link>
      ),
      meta: { className: "text-right whitespace-nowrap" },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-bold text-primary">
        {t("title")}
      </h1>
      <DataTable
        columns={columns}
        data={roles}
        getRowId={(role) => role._id}
      />
    </div>
  );
}
