"use client";

import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../convex/_generated/api";
import { Link } from "@/i18n/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LogoutButton } from "@/components/logout-button";

export function TopBar() {
  const t = useTranslations("Nav");
  const currentUser = useQuery(api.users.getCurrentUser);

  return (
    <div className="flex items-center gap-3">
      {currentUser?.isSuperAdmin ? (
        <Link
          href="/admin/users"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {t("manageUsers")}
        </Link>
      ) : null}
      <LocaleSwitcher />
      <LogoutButton />
    </div>
  );
}
