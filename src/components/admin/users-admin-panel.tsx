"use client";

import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { CreateUserDialog } from "@/components/admin/create-user-dialog";
import { UserStatusButton } from "@/components/admin/user-status-button";

export function UsersAdminPanel() {
  const t = useTranslations("Admin.users");
  const currentUser = useQuery(api.users.getCurrentUser);
  const users = useQuery(api.users.listUsers);

  if (currentUser === undefined || currentUser === null) {
    return null;
  }

  if (!currentUser.isSuperAdmin) {
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
