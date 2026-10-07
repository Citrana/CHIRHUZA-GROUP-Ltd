"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
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
import { ANALYTICS_COLORS, ChartLegend, CostsChart, SalesChart, Sparkline } from "@/components/analytics/analytics-charts";
import { ProductsSoldTable } from "@/components/analytics/products-sold-table";
import { percentChange, previousRange } from "@/lib/analytics-compare";
import { analyticsInsights } from "@/lib/analytics-insights";
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

type Delta = {
  /** % change vs the previous period (only shown when there is one). */
  pct: number;
  /** Costs: going up is bad. */
  inverse?: boolean;
  /** "vs Sep 1 – Sep 7". */
  compare: string;
  /** Screen-reader sentence. */
  aria: string;
};

/** "▲ 12%" / "▼ 8%": green when it's good news, red (amber on the hero) when not. */
function DeltaBadge({ delta, anchor }: { delta: Delta; anchor?: boolean }) {
  const up = delta.pct > 0;
  const good = delta.pct === 0 ? null : up !== Boolean(delta.inverse);
  const tone =
    good === null
      ? anchor
        ? "text-primary-foreground/80"
        : "text-muted-foreground"
      : good
        ? anchor
          ? "text-accent"
          : "text-[color:var(--chart-2)]"
        : anchor
          ? "text-amber-300"
          : "text-destructive";
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs" aria-label={delta.aria}>
      <span className={cn("font-semibold tabular-nums", tone)} aria-hidden>
        {up ? "▲" : delta.pct < 0 ? "▼" : "•"} {Math.abs(delta.pct)}%
      </span>
      <span className={anchor ? "text-primary-foreground/70" : "text-muted-foreground"} aria-hidden>
        {delta.compare}
      </span>
    </span>
  );
}

/**
 * A KPI card. The header row has a fixed height (label, its series colour
 * dot, an optional sparkline), so values line up across a row of cards.
 */
function StatCard({
  label,
  value,
  hint,
  tone,
  loading,
  delta,
  sparkline,
  dot,
  variant,
  badge,
  conceal,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "negative";
  loading: boolean;
  delta?: Delta;
  sparkline?: { values: number[]; color: string };
  /** The series colour this figure has in the charts. */
  dot?: string;
  variant?: "anchor";
  badge?: string;
  /** Start blurred, with an eye to show / hide the figure (labels for the eye). */
  conceal?: { show: string; hide: string; hidden: string };
  className?: string;
}) {
  const anchor = variant === "anchor";
  // Concealed figures start hidden on every visit (privacy on shared screens).
  const [shown, setShown] = useState(false);
  const hidden = Boolean(conceal) && !shown;
  const blur = conceal
    ? cn(
        "transition-[filter,opacity] duration-300 ease-out motion-reduce:transition-none",
        hidden ? "pointer-events-none select-none opacity-60 blur-[10px]" : "opacity-100 blur-0",
      )
    : undefined;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3",
        anchor ? "justify-center border-primary bg-primary p-4 text-primary-foreground sm:p-5" : "border-border",
        className,
      )}
    >
      <div className="flex h-5 items-center justify-between gap-2">
        <p className={cn("flex items-center gap-1.5 text-xs", anchor ? "text-primary-foreground/80" : "text-muted-foreground")}>
          {dot ? <span className="inline-block size-2 rounded-full" style={{ background: dot }} aria-hidden /> : null}
          {label}
          {conceal ? (
            <button
              type="button"
              onClick={() => setShown((v) => !v)}
              aria-pressed={shown}
              aria-label={shown ? conceal.hide : conceal.show}
              className={cn(
                "-my-3 inline-flex size-11 items-center justify-center rounded-full",
                anchor
                  ? "text-primary-foreground/80 hover:bg-primary-foreground/10 hover:text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
                "focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-current",
              )}
            >
              {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          ) : null}
        </p>
        {sparkline && !loading ? (
          <span className={blur} aria-hidden={hidden || undefined}>
            <Sparkline values={sparkline.values} color={anchor ? "var(--primary-foreground)" : sparkline.color} className="shrink-0" />
          </span>
        ) : null}
      </div>
      {loading ? (
        <Skeleton className={cn("mt-1 w-24", anchor ? "h-10 bg-primary-foreground/20" : "h-7")} />
      ) : (
        // Tapping the blurred figure also reveals it (hiding again is the eye's job).
        <div
          className={cn("flex flex-col gap-1", hidden && "cursor-pointer")}
          onClick={hidden ? () => setShown(true) : undefined}
        >
          {hidden ? <span className="sr-only">{conceal!.hidden}</span> : null}
          <div className={cn("flex flex-col gap-1", blur)} aria-hidden={hidden || undefined}>
            <p
              className={cn(
                "flex flex-wrap items-center gap-2 font-semibold tabular-nums",
                anchor ? "text-3xl sm:text-4xl" : "text-lg sm:text-xl",
                tone === "negative" && !anchor && "text-destructive",
              )}
            >
              {value}
              {badge ? <span className="rounded-full bg-amber-300 px-2 py-0.5 text-xs font-semibold text-primary">{badge}</span> : null}
            </p>
            {delta ? <DeltaBadge delta={delta} anchor={anchor} /> : null}
          </div>
        </div>
      )}
      {hint ? <p className={cn("text-xs", anchor ? "text-primary-foreground/70" : "text-muted-foreground")}>{hint}</p> : null}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Analytics (analytics.view): KPIs with the change vs the previous period,
 * highlights, trend charts, product lists and every product sold, for a
 * day / week / month / custom range, all locations or one. Reads only the
 * backend rollups (convex/analytics.ts).
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
  // "Day": today by default, or any earlier day.
  const [day, setDay] = useState(today);
  const [locationId, setLocationId] = useState("");

  const customValid = from !== "" && to !== "" && from <= to && to <= today && daysBetween(from, to) <= 366;
  const dayValid = day !== "" && day <= today;
  const range: RangeInput | null =
    period === "custom"
      ? customValid
        ? { from, to }
        : null
      : period === "today" && day !== today
        ? dayValid
          ? { from: day, to: day }
          : null
        : { preset: period };
  const granularity = granularityFor(period, from, to);
  const location = locationId ? { locationId: locationId as Id<"locations"> } : {};
  const args = canView && range ? { businessUnitKey: service, range, ...location } : "skip";

  const filters = useQuery(api.analytics.filterLocations, canView ? { businessUnitKey: service } : "skip");
  const summary = useQuery(api.analytics.getSummary, args);
  // The same figures for the period before, for the ▲/▼ on each card.
  const previous = summary ? previousRange(period, summary.from, summary.to) : null;
  const previousSummary = useQuery(
    api.analytics.getSummary,
    canView && previous ? { businessUnitKey: service, range: previous, ...location } : "skip",
  );
  const series = useQuery(api.analytics.getTimeSeries, args === "skip" ? "skip" : { ...args, granularity });
  const mostSold = useQuery(api.analytics.getTopProducts, args === "skip" ? "skip" : { ...args, by: "units", order: "desc" });
  const leastSold = useQuery(api.analytics.getTopProducts, args === "skip" ? "skip" : { ...args, by: "units", order: "asc" });
  const bestMargin = useQuery(api.analytics.getTopProducts, args === "skip" ? "skip" : { ...args, by: "margin", order: "desc" });
  const unsold = useQuery(api.analytics.getUnsoldProducts, args === "skip" ? "skip" : { ...args, limit: 5 });
  const productSales = useQuery(api.analytics.getProductSales, args);

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const loading = summary === undefined;
  const dayLabel = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const shortDay = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const asDate = (d: string) => Date.parse(`${d}T12:00:00Z`);
  const spanLabel = (a: string, b: string, format: Intl.DateTimeFormat) =>
    a === b ? format.format(asDate(a)) : `${format.format(asDate(a))} – ${format.format(asDate(b))}`;

  // "October 2026 (month to date)" for the month; the dates otherwise.
  let rangeLabel = "";
  if (summary) {
    if (period === "month") {
      const month = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(asDate(summary.from));
      const [y, m] = summary.from.split("-").map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      rangeLabel = Number(summary.to.slice(8, 10)) === lastDay ? month : t("monthToDate", { month });
    } else {
      rangeLabel = spanLabel(summary.from, summary.to, dayLabel);
    }
  }

  const compareLabel = previous ? spanLabel(previous.from, previous.to, shortDay) : "";
  const deltaFor = (key: "sales" | "margin" | "expenses" | "payroll" | "netProfit", inverse = false): Delta | undefined => {
    // Nothing to compare with (no previous figures): no delta at all.
    if (!summary || !previous || !previousSummary) return undefined;
    const pct = percentChange(summary[key], previousSummary[key]);
    if (pct === null) return undefined;
    const range = compareLabel;
    return {
      pct,
      inverse,
      compare: t("vsPrevious", { range }),
      aria: pct >= 0 ? t("deltaUp", { pct: Math.abs(pct), range }) : t("deltaDown", { pct: Math.abs(pct), range }),
    };
  };

  const shopName = locationId ? filters?.locations.find((l) => l._id === locationId)?.name : undefined;
  const productsSoldFileName = [
    "products-sold",
    service,
    productSales ? (productSales.from === productSales.to ? productSales.from : `${productSales.from}_${productSales.to}`) : today,
    shopName?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  ]
    .filter(Boolean)
    .join("-");

  const productName = (p: { name: string | null; lengthInches: number | null; sizeName: string | null; colourName: string | null }) =>
    [p.name ?? "—", p.lengthInches !== null ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
      .filter(Boolean)
      .join(" · ");

  // "20″ · 613 Blonde": tells similar products apart in the lists.
  const variantOf = (p: { lengthInches: number | null; sizeName: string | null; colourName: string | null }) =>
    [p.lengthInches !== null ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
      .filter(Boolean)
      .join(" · ");

  const listSkeleton = (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
  const productRows = <P extends { productId: string; sku: string | null; name: string | null; lengthInches: number | null; sizeName: string | null; colourName: string | null }>(
    products: P[],
    value: (p: P) => string,
  ) => (
    <ol className="flex flex-col divide-y divide-border">
      {products.map((p, i) => (
        <li key={p.productId} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
            <span className="min-w-0" title={productName(p)}>
              <span className="line-clamp-2 font-medium">{p.name ?? "—"}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {variantOf(p) ? <span className="rounded bg-muted px-1.5 py-0.5 text-foreground/80">{variantOf(p)}</span> : null}
                {p.sku}
              </span>
            </span>
          </span>
          <span className="shrink-0 font-medium tabular-nums">{value(p)}</span>
        </li>
      ))}
    </ol>
  );
  const productList = (data: typeof mostSold, value: (p: NonNullable<typeof mostSold>["products"][number]) => string) =>
    data === undefined ? (
      listSkeleton
    ) : data.products.length === 0 ? (
      <p className="text-sm text-muted-foreground">{t("noSales")}</p>
    ) : (
      productRows(data.products, value)
    );

  const points = series?.points ?? [];
  const chartGranularity = series?.granularity ?? granularity;
  const zeroDays = chartGranularity === "day" ? points.filter((p) => p.sales === 0 && p.start <= today).map((p) => p.start) : [];
  const spark = (pick: (p: (typeof points)[number]) => number) => points.map(pick);
  const chartRange = summary ? spanLabel(summary.from, summary.to, dayLabel) : "";
  const hasActivity = (keys: Array<"sales" | "expenses" | "payroll">) => points.some((p) => keys.some((k) => p[k] !== 0));
  const chartOrEmpty = (keys: Array<"sales" | "expenses" | "payroll">, node: React.ReactNode) =>
    series === undefined ? (
      <Skeleton className="h-56 sm:h-64" />
    ) : hasActivity(keys) ? (
      node
    ) : (
      <p className="py-8 text-center text-sm text-muted-foreground">{t("noData")}</p>
    );

  const topProduct = productSales?.rows.length
    ? [...productSales.rows].sort((a, b) => b.revenue - a.revenue)[0]
    : null;
  const insights =
    summary && series
      ? analyticsInsights(
          {
            summary,
            previous: previousSummary ?? null,
            points,
            granularity: chartGranularity,
            today,
            topProduct: topProduct ? { label: productName(topProduct), revenue: topProduct.revenue } : null,
          },
          { t: (key, values) => t(key as Parameters<typeof t>[0], values), formatDay: (d) => shortDay.format(asDate(d)) },
        )
      : [];

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
          {period === "today" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="analytics-day" className="text-xs text-muted-foreground">
                {t("dayLabel")}
              </Label>
              <Input id="analytics-day" type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="h-10 w-40" />
            </div>
          ) : null}
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

      {/* KPIs: net profit as the hero, the four others beside it, withdrawals apart below */}
      <section className="flex flex-col gap-3" aria-label={t("totalsLabel")}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            variant="anchor"
            className="col-span-2 lg:col-span-1 lg:row-span-2"
            label={t("cards.netProfit")}
            value={summary ? money(summary.netProfit) : ""}
            badge={summary && summary.netProfit < 0 ? t("loss") : undefined}
            conceal={{ show: t("showNetProfit"), hide: t("hideNetProfit"), hidden: t("hiddenValue") }}
            hint={t("netProfitHint")}
            loading={loading}
            delta={deltaFor("netProfit")}
            sparkline={{ values: spark((p) => p.margin - p.expenses - p.payroll), color: ANALYTICS_COLORS.sales }}
          />
          <StatCard
            label={t("cards.sales")}
            dot={ANALYTICS_COLORS.sales}
            value={summary ? money(summary.sales) : ""}
            loading={loading}
            delta={deltaFor("sales")}
            sparkline={{ values: spark((p) => p.sales), color: ANALYTICS_COLORS.sales }}
          />
          <StatCard
            label={t("cards.margin")}
            dot={ANALYTICS_COLORS.margin}
            value={summary ? money(summary.margin) : ""}
            hint={summary?.marginPct != null ? t("marginPct", { pct: summary.marginPct }) : undefined}
            tone={summary && summary.margin < 0 ? "negative" : undefined}
            loading={loading}
            delta={deltaFor("margin")}
            sparkline={{ values: spark((p) => p.margin), color: ANALYTICS_COLORS.margin }}
          />
          <StatCard
            label={t("cards.expenses")}
            dot={ANALYTICS_COLORS.expenses}
            value={summary ? money(summary.expenses) : ""}
            hint={t("expensesHint")}
            loading={loading}
            delta={deltaFor("expenses", true)}
          />
          <StatCard
            label={t("cards.payroll")}
            dot={ANALYTICS_COLORS.payroll}
            value={summary ? money(summary.payroll) : ""}
            loading={loading}
            delta={deltaFor("payroll", true)}
          />
        </div>
        {/* Withdrawals: shown apart, never part of profit */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2">
          <span className="text-xs text-muted-foreground">{t("cards.withdrawals")}</span>
          {loading ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            <span className="font-semibold tabular-nums">{summary ? money(summary.withdrawals) : ""}</span>
          )}
          <span className="text-xs text-muted-foreground">{t("withdrawalsHint")}</span>
        </div>
      </section>

      {/* Highlights: warnings tinted, facts as plain text */}
      {insights.length > 0 ? (
        <div role="note" aria-label={t("insightsLabel")} className="flex flex-wrap items-center gap-2 text-sm">
          {insights
            .filter((i) => i.tone === "warning")
            .map((i) => (
              <span
                key={i.text}
                className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-900 dark:text-amber-200"
              >
                {i.text}
              </span>
            ))}
          {insights.some((i) => i.tone === "info") ? (
            <span className="text-muted-foreground">
              {insights
                .filter((i) => i.tone === "info")
                .map((i) => i.text)
                .join(" · ")}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Trends */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section
          title={t("charts.sales")}
          aside={
            <ChartLegend
              items={[
                { label: t("cards.sales"), color: ANALYTICS_COLORS.sales, shape: "line" },
                { label: t("cards.margin"), color: ANALYTICS_COLORS.margin, shape: "line" },
                ...(zeroDays.length > 0 ? [{ label: t("legend.noSales"), color: ANALYTICS_COLORS.noSales, shape: "dot" as const }] : []),
              ]}
            />
          }
        >
          {chartOrEmpty(
            ["sales"],
            <SalesChart
              points={points}
              granularity={chartGranularity}
              labels={{ sales: t("cards.sales"), margin: t("cards.margin") }}
              zeroDays={zeroDays}
              ariaLabel={t("chartLabels.sales", { range: chartRange })}
            />,
          )}
        </Section>
        <Section
          title={t("charts.costs")}
          aside={
            <ChartLegend
              items={[
                { label: t("cards.expenses"), color: ANALYTICS_COLORS.expenses },
                { label: t("cards.payroll"), color: ANALYTICS_COLORS.payroll },
              ]}
            />
          }
        >
          {chartOrEmpty(
            ["expenses", "payroll"],
            <CostsChart
              points={points}
              granularity={chartGranularity}
              labels={{ expenses: t("cards.expenses"), payroll: t("cards.payroll") }}
              ariaLabel={t("chartLabels.costs", { range: chartRange })}
            />,
          )}
        </Section>
      </div>

      {/* Product lists */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Section title={t("lists.mostSold")}>{productList(mostSold, (p) => t("pieces", { count: p.unitsSold }))}</Section>
        <Section title={t("lists.leastSold")}>{productList(leastSold, (p) => t("pieces", { count: p.unitsSold }))}</Section>
        <Section title={t("lists.bestMargin")}>{productList(bestMargin, (p) => money(p.margin))}</Section>
        <Section title={t("lists.noSales")}>
          {unsold === undefined ? (
            listSkeleton
          ) : unsold.products.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("unsold.none")}</p>
          ) : (
            <>
              {productRows(unsold.products, (p) => t("unsold.inStock", { count: p.onHand }))}
              {unsold.total > unsold.products.length ? (
                <p className="text-xs text-muted-foreground">{t("unsold.more", { count: unsold.total - unsold.products.length })}</p>
              ) : null}
            </>
          )}
        </Section>
      </div>

      {/* Every product sold in the range */}
      <Section title={t("productsSold.title")}>
        <ProductsSoldTable report={productSales} fileName={productsSoldFileName} />
      </Section>

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
