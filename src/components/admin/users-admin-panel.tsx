"use client";

import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { UserStatusButton } from "@/components/admin/user-status-button";
import { UserRoleSelect } from "@/components/admin/user-role-select";
import { useRoleText } from "@/components/admin/use-role-text";
import { useCan } from "@/lib/use-can";

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

  if (!currentUser || canManageUsers === undefined) {
    return null;
  }

  if (!canManageUsers) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold text-primary">
          {t("title")}
        </h1>
        <CreateUserDialog />
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary text-secondary-foreground">
            <tr>
              <th className="p-3 text-left font-medium">{t("nameHeader")}</th>
              <th className="p-3 text-left font-medium">
                {t("emailHeader")}
              </th>
              <th className="p-3 text-left font-medium">{t("roleHeader")}</th>
              <th className="p-3 text-left font-medium">
                {t("statusHeader")}
              </th>
              <th className="p-3 text-right font-medium">
                {t("actionsHeader")}
              </th>
            </tr>
          </thead>
          <tbody>
            {users?.map((user) => (
              <tr key={user._id} className="border-t border-border">
                <td className="p-3">{user.name}</td>
                <td className="p-3 text-muted-foreground">{user.email}</td>
                <td className="p-3">
                  {canManageRoles && roles && user._id !== currentUser._id ? (
                    <UserRoleSelect
                      userId={user._id}
                      roleId={user.roleId}
                      roles={roles}
                    />
                  ) : (
                    <Badge variant="outline">
                      {user.roleKey && user.roleName
                        ? roleText({ key: user.roleKey, name: user.roleName })
                            .name
                        : t("noRole")}
                    </Badge>
                  )}
                </td>
                <td className="p-3">
                  <Badge
                    variant={
                      user.status === "active" ? "secondary" : "destructive"
                    }
                  >
                    {user.status === "active"
                      ? t("statusActive")
                      : t("statusBlocked")}
                  </Badge>
                </td>
                <td className="p-3 text-right">
                  {user._id === currentUser._id ? null : (
                    <UserStatusButton user={user} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
