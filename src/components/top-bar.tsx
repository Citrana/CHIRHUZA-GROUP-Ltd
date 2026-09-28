"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LogoutButton } from "@/components/logout-button";
import { useCan } from "@/lib/use-can";

export function TopBar() {
  const t = useTranslations("Nav");
  const canManageUsers = useCan("users.manage");
  const canManageRoles = useCan("roles.manage");

  return (
    <div className="flex items-center gap-3">
      {canManageUsers ? (
        <Link
          href="/admin/users"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {t("manageUsers")}
        </Link>
      ) : null}
      {canManageRoles ? (
        <Link
          href="/admin/roles"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {t("manageRoles")}
        </Link>
      ) : null}
      <LocaleSwitcher />
      <LogoutButton />
    </div>
  );
}
