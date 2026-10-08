"use client";

import { ChevronDown, MapPin, ScrollText, ShieldCheck, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** The admin pages the user may open (each needs its permission). */
function useAdminLinks() {
  const t = useTranslations("Nav");
  const canManageUsers = useCan("users.manage");
  const canManageRoles = useCan("roles.manage");
  const canManageLocations = useCan("locations.manage");
  const canViewAudit = useCan("audit.view");

  return [
    { href: "/admin/users", label: t("manageUsers"), icon: Users, show: canManageUsers },
    { href: "/admin/roles", label: t("manageRoles"), icon: ShieldCheck, show: canManageRoles },
    { href: "/admin/locations", label: t("manageLocations"), icon: MapPin, show: canManageLocations },
    { href: "/admin/audit", label: t("auditLog"), icon: ScrollText, show: canViewAudit },
  ].filter((link) => link.show);
}

/** Admin page links, each shown only if the user holds its permission (mobile account sheet). */
export function AdminLinks({
  className,
  linkClassName,
  onNavigate,
  title,
}: {
  className?: string;
  linkClassName?: string;
  onNavigate?: () => void;
  /** A small label above the links (only shown when there are links). */
  title?: string;
}) {
  const links = useAdminLinks();
  if (links.length === 0) {
    return null;
  }

  return (
    <nav className={className} aria-label={title}>
      {title ? <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p> : null}
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

/**
 * The header's "Admin" dropdown (desktop): the admin pages the user may
 * open. Not rendered at all for users with none of them.
 */
export function AdminMenu() {
  const t = useTranslations("AppHeader");
  const links = useAdminLinks();
  if (links.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="gap-1 text-sm text-muted-foreground hover:text-foreground" />}>
        {t("admin")}
        <ChevronDown className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {links.map(({ href, label, icon: Icon }) => (
          <DropdownMenuLinkItem key={href} render={<Link href={href} />}>
            <Icon className="size-4 text-muted-foreground" aria-hidden />
            {label}
          </DropdownMenuLinkItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
