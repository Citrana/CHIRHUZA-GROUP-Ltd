"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { daysBetween, monthStart, type RangeInput } from "../../../convex/lib/analytics";
import { formatMoney } from "../../../convex/lib/money";
import { businessDayOf } from "../../../convex/lib/time";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { MoneyChart } from "@/components/analytics/analytics-charts";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

const PERIODS = ["today", "week", "month", "custom"] as const;
type Period = (typeof PERIODS)[number];
type Granularity = "day" | "week" | "month";

/** Daily points up to ~2 months, then weekly, then monthly. */
function granularityFor(period: Period, from: string, to: string): Granularity {
  if (period !== "custom") return "day";
  const days = daysBetween(from, to);
  return days <= 62 ? "day" : days <= 180 ? "week" : "month";
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden />;
}

function StatCard({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "negative" | "muted";
  loading: boolean;
}) {
  return (
    <div className={cn("rounded-lg border border-border p-3", tone === "muted" && "border-dashed bg-muted/30")}>
      <p className="text-xs text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-7 w-24" />
      ) : (
        <p className={cn("text-lg font-semibold tabular-nums sm:text-xl", tone === "negative" && "text-destructive")}>{value}</p>
      )}
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="font-heading text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Hair analytics (analytics.view): totals, net profit, top products and
 * charts for a day / week / month / custom range, all locations or one.
 * Reads only the backend rollups (convex/analytics.ts).
 */
export function AnalyticsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Analytics");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canView = useCan("analytics.view");
  const [today] = useState(() => businessDayOf(Date.now()));
  const [period, setPeriod] = useState<Period>("month");
  const [from, setFrom] = useState(() => monthStart(businessDayOf(Date.now())));
  const [to, setTo] = useState(today);
  const [locationId, setLocationId] = useState("");

  const customValid = from !== "" && to !== "" && from <= to && to <= today && daysBetween(from, to) <= 366;
  const range: RangeInput | null = period === "custom" ? (customValid ? { from, to } : null) : { preset: period };
  const granularity = granularityFor(period, from, to);
  const args =
    canView && range
      ? { businessUnitKey: service, range, ...(locationId ? { locationId: locationId as Id<"locations"> } : {}) }
      : "skip";

  const filters = useQuery(api.analytics.filterLocations, canView ? { businessUnitKey: service } : "skip");
  const summary = useQuery(api.analytics.getSummary, args);
  const series = useQuery(api.analytics.getTimeSeries, args === "skip" ? "skip" : { ...args, granularity });
  const mostSold = useQuery(api.analytics.getTopProducts, args === "skip" ? "skip" : { ...args, by: "units", order: "desc" });
  const leastSold = useQuery(api.analytics.getTopProducts, args === "skip" ? "skip" : { ...args, by: "units", order: "asc" });
  const bestMargin = useQuery(api.analytics.getTopProducts, args === "skip" ? "skip" : { ...args, by: "margin", order: "desc" });

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const loading = summary === undefined;
  const dayLabel = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const rangeLabel = summary
    ? summary.from === summary.to
      ? dayLabel.format(Date.parse(`${summary.from}T12:00:00Z`))
      : `${dayLabel.format(Date.parse(`${summary.from}T12:00:00Z`))} – ${dayLabel.format(Date.parse(`${summary.to}T12:00:00Z`))}`
    : "";

  const productList = (data: typeof mostSold, value: (p: NonNullable<typeof mostSold>["products"][number]) => string) =>
    data === undefined ? (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    ) : data.products.length === 0 ? (
      <p className="text-sm text-muted-foreground">{t("noSales")}</p>
    ) : (
      <ol className="flex flex-col divide-y divide-border">
        {data.products.map((p, i) => (
          <li key={p.productId} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {[p.name ?? "—", p.lengthInches !== null ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="block text-xs text-muted-foreground">{p.sku}</span>
              </span>
            </span>
            <span className="shrink-0 font-medium tabular-nums">{value(p)}</span>
          </li>
        ))}
      </ol>
    );

  const points = series?.points ?? [];
  const hasActivity = (key: "sales" | "expenses" | "payroll") => points.some((p) => p[key] !== 0);
  const chart = (key: "sales" | "expenses" | "payroll", node: React.ReactNode) =>
    series === undefined ? <Skeleton className="h-56 sm:h-64" /> : hasActivity(key) ? node : <p className="py-8 text-center text-sm text-muted-foreground">{t("noData")}</p>;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{rangeLabel || t("subtitle")}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div role="radiogroup" aria-label={t("periodLabel")} className="grid grid-cols-4 gap-1 rounded-lg border border-border p-1 sm:inline-grid sm:self-start">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={period === p}
              onClick={() => setPeriod(p)}
              className={cn(
                "min-h-10 rounded-md px-3 text-sm font-medium",
                period === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`periods.${p}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {period === "custom" ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="analytics-from" className="text-xs text-muted-foreground">
                  {t("fromLabel")}
                </Label>
                <Input id="analytics-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="analytics-to" className="text-xs text-muted-foreground">
                  {t("toLabel")}
                </Label>
                <Input id="analytics-to" type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} className="h-10 w-40" />
              </div>
            </>
          ) : null}
          {filters && !filters.locked ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="analytics-location" className="text-xs text-muted-foreground">
                {t("locationLabel")}
              </Label>
              <NativeSelect id="analytics-location" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-10 w-48">
                <option value="">{t("allLocations")}</option>
                {filters.locations.map((l) => (
                  <option key={l._id} value={l._id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : filters?.locked ? (
            <p className="text-sm text-muted-foreground">{t("lockedLocation", { name: filters.locations[0]?.name ?? "—" })}</p>
          ) : null}
        </div>
        {period === "custom" && !customValid ? <p className="text-sm text-destructive">{t("invalidRange")}</p> : null}
      </div>

      {/* Cards */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3" aria-label={t("totalsLabel")}>
        <StatCard label={t("cards.sales")} value={summary ? money(summary.sales) : ""} loading={loading} />
        <StatCard
          label={t("cards.margin")}
          value={summary ? money(summary.margin) : ""}
          hint={summary?.marginPct != null ? t("marginPct", { pct: summary.marginPct }) : undefined}
          tone={summary && summary.margin < 0 ? "negative" : undefined}
          loading={loading}
        />
        <StatCard label={t("cards.expenses")} value={summary ? money(summary.expenses) : ""} hint={t("expensesHint")} loading={loading} />
        <StatCard label={t("cards.payroll")} value={summary ? money(summary.payroll) : ""} loading={loading} />
        <StatCard
          label={t("cards.netProfit")}
          value={summary ? money(summary.netProfit) : ""}
          hint={t("netProfitHint")}
          tone={summary && summary.netProfit < 0 ? "negative" : undefined}
          loading={loading}
        />
        <StatCard
          label={t("cards.withdrawals")}
          value={summary ? money(summary.withdrawals) : ""}
          hint={t("withdrawalsHint")}
          tone="muted"
          loading={loading}
        />
      </section>

      {/* Lists */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Section title={t("lists.mostSold")}>{productList(mostSold, (p) => t("pieces", { count: p.unitsSold }))}</Section>
        <Section title={t("lists.leastSold")}>{productList(leastSold, (p) => t("pieces", { count: p.unitsSold }))}</Section>
        <Section title={t("lists.bestMargin")}>{productList(bestMargin, (p) => money(p.margin))}</Section>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section title={t("charts.sales")}>
          {chart(
            "sales",
            <MoneyChart
              kind="area"
              points={points}
              granularity={series?.granularity ?? granularity}
              series={[
                { key: "sales", label: t("cards.sales"), color: "var(--chart-2)" },
                { key: "margin", label: t("cards.margin"), color: "var(--chart-4)" },
              ]}
            />,
          )}
        </Section>
        <Section title={t("charts.expenses")}>
          {chart(
            "expenses",
            <MoneyChart
              kind="bar"
              points={points}
              granularity={series?.granularity ?? granularity}
              series={[{ key: "expenses", label: t("cards.expenses"), color: "var(--chart-3)" }]}
            />,
          )}
        </Section>
        <Section title={t("charts.payroll")}>
          {chart(
            "payroll",
            <MoneyChart
              kind="bar"
              points={points}
              granularity={series?.granularity ?? granularity}
              series={[{ key: "payroll", label: t("cards.payroll"), color: "var(--chart-1)" }]}
            />,
          )}
        </Section>
      </div>
      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
