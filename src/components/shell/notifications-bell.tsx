"use client";

import { useState } from "react";
import { Bell } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDay } from "@/lib/report-pdf";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/** In-app notifications (reports ready or failed): unread count, latest list, mark read. */
export function NotificationsBell() {
  const t = useTranslations("Reports.notifications");
  const locale = useLocale();
  const router = useRouter();
  const canView = useCan("reports.view");
  const inbox = useQuery(api.reports.myNotifications, canView ? {} : "skip");
  const markRead = useMutation(api.reports.markRead);
  const [open, setOpen] = useState(false);
  if (!canView) return null;

  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const unread = inbox?.unread ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="relative size-11" aria-label={unread > 0 ? `${t("open")} (${unread})` : t("open")} />}
      >
        <Bell />
        {unread > 0 ? (
          <span className="absolute top-1.5 right-1.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="text-sm font-medium">{t("title")}</p>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" className="min-h-9" onClick={() => void markRead({})}>
              {t("markAll")}
            </Button>
          ) : null}
        </div>
        {inbox && inbox.items.length > 0 ? (
          <ul className="max-h-80 overflow-y-auto">
            {inbox.items.map((n) => (
              <li key={n._id}>
                <button
                  type="button"
                  className={cn("flex min-h-11 w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted", !n.read && "bg-secondary/40")}
                  onClick={() => {
                    if (!n.read) void markRead({ notificationId: n._id });
                    setOpen(false);
                    router.push(`/${n.businessUnitKey}/reports/${n.reportId}`);
                  }}
                >
                  <span className={cn(!n.read && "font-medium", n.status === "failed" && "text-destructive")}>
                    {t(n.status === "failed" ? "failed" : "ready", { from: formatDay(n.from, locale), to: formatDay(n.to, locale) })}
                  </span>
                  <span className="text-xs text-muted-foreground">{when.format(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-sm text-muted-foreground">{t("empty")}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
