"use client";

import { useQuery } from "convex/react";
import type { DataTableColumn } from "@/components/data-table/features";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { DataTable } from "@/components/data-table/data-table";
import { Badge } from "@/components/ui/badge";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { UserStatusButton } from "@/components/admin/user-status-button";
import { ResetPasswordButton } from "@/components/admin/reset-password-button";
import { UserRoleSelect } from "@/components/admin/user-role-select";
import { UserLocationSelect } from "@/components/admin/user-location-select";
import { useRoleText } from "@/components/admin/use-role-text";
import { useCan } from "@/lib/use-can";

type UserRow = FunctionReturnType<typeof api.users.listUsers>[number];

export function UsersAdminPanel() {
  const t = useTranslations("Admin.users");
  const roleText = useRoleText();
  const currentUser = useQuery(api.users.getCurrentUser);
  const canManageUsers = useCan("users.manage");
  const canManageRoles = useCan("roles.manage");
  // Skip (rather than let the server reject) queries the user can't run.
  const users = useQuery(api.users.listUsers, canManageUsers ? {} : "skip");
  const roles = useQuery(
    api.rbac.listRoleOptions,
    canManageUsers ? {} : "skip",
  );

  const requiresLocation = new Set(
    roles?.filter((r) => r.requiresLocation).map((r) => r._id),
  );

  if (!currentUser || canManageUsers === undefined) {
    return null;
  }

  if (!canManageUsers) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const isSelf = (user: UserRow) => user._id === currentUser._id;

  const roleCell = (user: UserRow) =>
    canManageRoles && roles && !isSelf(user) ? (
      <UserRoleSelect userId={user._id} roleId={user.roleId} roles={roles} />
    ) : (
      <Badge variant="outline">
        {user.roleKey && user.roleName
          ? roleText({ key: user.roleKey, name: user.roleName }).name
          : t("noRole")}
      </Badge>
    );

  const locationCell = (user: UserRow) => (
    <UserLocationSelect
      userId={user._id}
      locationId={user.locationId}
      required={user.roleId !== null && requiresLocation.has(user.roleId)}
    />
  );

  const statusBadge = (user: UserRow) => (
    <Badge variant={user.status === "active" ? "secondary" : "destructive"}>
      {user.status === "active" ? t("statusActive") : t("statusBlocked")}
    </Badge>
  );

  const columns: DataTableColumn<UserRow>[] = [
    {
      accessorKey: "name",
      header: t("nameHeader"),
      enableSorting: true,
      meta: { className: "font-medium" },
    },
    {
      accessorKey: "email",
      header: t("emailHeader"),
      enableSorting: true,
      meta: { className: "text-muted-foreground" },
    },
    {
      id: "role",
      header: t("roleHeader"),
      cell: ({ row }) => roleCell(row.original),
      meta: { className: "min-w-44" },
    },
    {
      id: "location",
      header: t("locationHeader"),
      cell: ({ row }) => locationCell(row.original),
      meta: { className: "min-w-44" },
    },
    {
      accessorKey: "status",
      header: t("statusHeader"),
      enableSorting: true,
      cell: ({ row }) => statusBadge(row.original),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("actionsHeader")}</span>,
      cell: ({ row }) =>
        isSelf(row.original) ? null : (
          <span className="inline-flex flex-wrap justify-end gap-2">
            <ResetPasswordButton user={row.original} />
            <UserStatusButton user={row.original} />
          </span>
        ),
      meta: { className: "text-right" },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-bold text-primary">
          {t("title")}
        </h1>
        <CreateUserDialog />
      </div>

      <DataTable
        columns={columns}
        data={users}
        getRowId={(user) => user._id}
        search={{ placeholder: t("searchPlaceholder") }}
        initialSorting={[{ id: "name", desc: false }]}
        renderCard={(user) => (
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{user.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {user.email}
                </p>
              </div>
              {statusBadge(user)}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t("roleHeader")}</span>
              {roleCell(user)}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t("locationHeader")}
              </span>
              {locationCell(user)}
            </div>
            {isSelf(user) ? null : (
              <div className="flex flex-wrap gap-2">
                <ResetPasswordButton user={user} />
                <UserStatusButton user={user} />
              </div>
            )}
          </div>
        )}
      />
    </div>
  );
}
