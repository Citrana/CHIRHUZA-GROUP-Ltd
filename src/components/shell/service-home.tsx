"use client";

import { useState } from "react";
import { CircleCheck, ChevronRight } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import {
  SHOW_DAILY_QUOTE,
  businessHour,
  firstName,
  greetingKey,
  homeAttention,
  quoteIndex,
  type AttentionRow,
} from "@/lib/home-briefing";
import type { ShellModuleKey } from "@/lib/shell-modules";
import { useCan } from "@/lib/use-can";
import { useVisibleModules } from "@/lib/use-visible-modules";
import { cn } from "@/lib/utils";

type Summary = FunctionReturnType<typeof api.home.summary>;

const SEVERITY_DOT: Record<AttentionRow["severity"], string> = {
  danger: "bg-destructive",
  warning: "bg-amber-500",
  neutral: "bg-muted-foreground/40",
};

/**
 * A service's Home: a greeting (business time zone) with today's date and
 * a quote of the day, what needs attention - reminders that appear only
 * when relevant to this user and go once resolved, or "All caught up" -
 * then a compact grid of the user's modules, each with one neutral
 * figure. Data comes from one summary query (convex/home.ts), which only
 * includes what the user may see.
 */
export function ServiceHome({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Home");
  const tShell = useTranslations("Shell");
  const tModules = useTranslations("Modules");
  const tUnits = useTranslations("BusinessUnits");
  const locale = useLocale();
  const modules = useVisibleModules();
  const me = useQuery(api.users.getCurrentUser);
  const summary = useQuery(api.home.summary, { businessUnitKey: service });
  const canRecordSales = useCan("sales.create");
  // The moment the page opened (greeting, date, quote and the 16:00 reminder).
  const [now] = useState(() => Date.now());

  if (modules === undefined) {
    return null;
  }

  const hour = businessHour(now);
  const today = businessDayOf(now);
  const longDate = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(now);
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const tAny = (key: string, values?: Record<string, string | number>) => t(key as Parameters<typeof t>[0], values);

  const attention = summary
    ? homeAttention(summary, { service, hour, canRecordSales: Boolean(canRecordSales), t: tAny, money })
    : null;

  // One neutral figure per module card ("" while loading).
  const metric = (key: ShellModuleKey, s: Summary | undefined): string => {
    if (!s) return "";
    switch (key) {
      case "analytics":
        return s.monthToDate ? t("metrics.salesMonth", { amount: money(s.monthToDate.sales) }) : "";
      case "approvals":
        return s.approvalsWaiting > 0 ? t("metrics.approvals", { count: s.approvalsWaiting }) : t("metrics.nothingWaiting");
      case "products":
        return s.productsActive !== null ? t("metrics.products", { count: s.productsActive }) : "";
      case "requisitions":
        return s.requisitionsOpen !== null ? t("metrics.requisitionsOpen", { count: s.requisitionsOpen }) : "";
      case "stock":
        return s.stock ? t("metrics.unitsOnHand", { count: s.stock.unitsOnHand }) : "";
      case "sales":
        return s.salesToday ? t("metrics.salesToday", { amount: money(s.salesToday.amount) }) : "";
      case "payroll":
        return s.payroll
          ? "paidThisMonth" in s.payroll
            ? t("metrics.paidThisMonth", { amount: money(s.payroll.paidThisMonth) })
            : t("metrics.pending", { count: s.payroll.minePending })
          : "";
      case "withdrawals":
        return s.withdrawals
          ? "thisMonth" in s.withdrawals
            ? t("metrics.withdrawalsMonth", { amount: money(s.withdrawals.thisMonth) })
            : t("metrics.pending", { count: s.withdrawals.minePending })
          : "";
      default:
        return "";
    }
  };

  const cardBody = (Icon: React.ElementType, name: string, figure: string) => (
    <>
      <Icon className="size-5 shrink-0 text-primary" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium leading-5">{name}</span>
        <span className="h-4 truncate text-xs leading-4 text-muted-foreground tabular-nums">{figure}</span>
      </span>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      {/* Greeting, in the business time zone */}
      <div className="flex flex-col gap-1">
        <h1 className="scroll-mt-16 font-heading text-2xl font-bold text-primary">
          {me ? t(`greeting.${greetingKey(hour)}`, { name: firstName(me.name, me.email) }) : tUnits(service)}
        </h1>
        <p className="text-sm text-muted-foreground">{t("subtitle", { service: tUnits(service), date: longDate })}</p>
        {SHOW_DAILY_QUOTE ? (
          <p className="text-sm text-muted-foreground/80 italic">“{t(`quotes.q${quoteIndex(today)}` as Parameters<typeof t>[0])}”</p>
        ) : null}
        {modules.length === 0 ? <p className="text-muted-foreground">{tShell("noModules")}</p> : null}
      </div>

      {/* Needs attention: reminders for this user, or "All caught up" */}
      {attention ? (
        <section aria-labelledby="home-attention" className="rounded-lg border border-border bg-card">
          <h2 id="home-attention" className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("attentionTitle")}
          </h2>
          {attention.length === 0 ? (
            <p className="flex min-h-11 items-center gap-3 px-4 pb-3 text-sm">
              <CircleCheck className="size-4 shrink-0 text-[color:var(--chart-2)]" aria-hidden />
              <span className="font-medium">{t("allCaughtUp")}</span>
              <span className="text-muted-foreground">{t("allCaughtUpHint")}</span>
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map((item) => (
                <li key={item.key}>
                  <Link href={item.href} className="flex min-h-11 items-center gap-3 px-4 py-2 text-sm hover:bg-muted/50">
                    <span className={cn("size-2 shrink-0 rounded-full", SEVERITY_DOT[item.severity])} aria-hidden />
                    <span className="min-w-0 flex-1">{item.label}</span>
                    {item.count ? (
                      <span
                        className={cn(
                          "font-semibold tabular-nums",
                          item.severity === "danger" && "text-destructive",
                          item.severity === "warning" && "text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {item.count}
                      </span>
                    ) : null}
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* Modules: one compact grid, each card with one neutral figure */}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {modules.map((m) => (
          <li key={m.key}>
            {"comingSoon" in m && m.comingSoon ? (
              // Not built yet: shown, but not a link.
              <div
                aria-disabled
                className="flex h-20 items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 opacity-60"
              >
                {cardBody(m.icon, tModules(m.key), t("metrics.notAvailable"))}
              </div>
            ) : (
              <Link
                href={`/${service}/${m.key}`}
                className="flex h-20 items-center gap-3 rounded-xl border border-border bg-card px-4 transition-colors hover:border-primary hover:bg-muted/50"
              >
                {cardBody(m.icon, tModules(m.key), metric(m.key, summary))}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
