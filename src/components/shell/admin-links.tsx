"use client";

import { MapPin, ShieldCheck, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/** Admin page links, each shown only if the user holds its permission. */
export function AdminLinks({
  className,
  linkClassName,
  onNavigate,
}: {
  className?: string;
  linkClassName?: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Nav");
  const canManageUsers = useCan("users.manage");
  const canManageRoles = useCan("roles.manage");
  const canManageLocations = useCan("locations.manage");

  const links = [
    { href: "/admin/users", label: t("manageUsers"), icon: Users, show: canManageUsers },
    { href: "/admin/roles", label: t("manageRoles"), icon: ShieldCheck, show: canManageRoles },
    { href: "/admin/locations", label: t("manageLocations"), icon: MapPin, show: canManageLocations },
  ].filter((link) => link.show);

  if (links.length === 0) {
    return null;
  }

  return (
    <nav className={className}>
      {links.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground",
            linkClassName,
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
