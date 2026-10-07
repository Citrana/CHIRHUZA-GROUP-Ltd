"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLocale } from "next-intl";
import { formatMoney } from "../../../convex/lib/money";

export type SeriesPoint = {
  start: string;
  sales: number;
  margin: number;
  expenses: number;
  payroll: number;
  withdrawals: number;
};

type Granularity = "day" | "week" | "month";

/**
 * One meaning, one colour - on every chart, sparkline and legend. From the
 * theme tokens (light and dark mode): greens for sales and margin, warm
 * tones (--chart-cost-*) for costs, amber for "no sales"
 * (as on the Stock page's low-stock figures).
 */
export const ANALYTICS_COLORS = {
  sales: "var(--chart-2)",
  margin: "var(--chart-4)",
  expenses: "var(--chart-cost-1)",
  payroll: "var(--chart-cost-2)",
  noSales: "#d97706",
} as const;

/** Short axis labels: "1 Oct" per day/week, "Oct 2026" per month. */
function useBucketLabel(granularity: Granularity) {
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(
    locale,
    granularity === "month" ? { month: "short", year: "numeric", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" },
  );
  return (start: string) => format.format(Date.parse(`${start}T12:00:00Z`));
}

function useCompactMoney() {
  const locale = useLocale();
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  return (cents: number) => `$${compact.format(cents / 100)}`;
}

function MoneyTooltip({
  active,
  payload,
  label,
  labelFor,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  labelFor: (start: string) => string;
}) {
  const locale = useLocale();
  if (!active || !payload?.length || !label) return null;
  // The area under the sales line repeats the sales value: show it once.
  const seen = new Set<string>();
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{labelFor(label)}</p>
      {payload
        .filter((p) => (p.name && !seen.has(p.name) ? (seen.add(p.name), true) : false))
        .map((p) => (
          <p key={p.name} className="flex items-center gap-2 tabular-nums">
            <span className="inline-block size-2 rounded-full" style={{ background: p.color }} aria-hidden />
            {p.name}: {formatMoney(p.value ?? 0, "USD", locale)}
          </p>
        ))}
    </div>
  );
}

/** A small legend above a chart: coloured swatch + label per series. */
export function ChartLegend({ items }: { items: Array<{ label: string; color: string; shape?: "line" | "box" | "dot" }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={item.shape === "line" ? "h-0.5 w-4 rounded" : item.shape === "dot" ? "size-2 rounded-full" : "size-2.5 rounded-sm"}
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };

function Axes({ granularity }: { granularity: Granularity }) {
  const labelFor = useBucketLabel(granularity);
  const compact = useCompactMoney();
  return (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
      <XAxis dataKey="start" tickFormatter={labelFor} tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
      <YAxis tickFormatter={compact} tick={AXIS} tickLine={false} axisLine={false} width={52} />
      <Tooltip content={<MoneyTooltip labelFor={labelFor} />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
    </>
  );
}

/**
 * Sales and margin per period as straight lines (a light fill under
 * sales). Days with no sale (`zeroDays`) get an amber dot on the axis.
 */
export function SalesChart({
  points,
  granularity,
  labels,
  zeroDays,
  ariaLabel,
}: {
  points: SeriesPoint[];
  granularity: Granularity;
  labels: { sales: string; margin: string };
  zeroDays: string[];
  ariaLabel: string;
}) {
  const labelFor = useBucketLabel(granularity);
  const compact = useCompactMoney();
  return (
    <div className="h-56 w-full sm:h-64" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="start" tickFormatter={labelFor} tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis tickFormatter={compact} tick={AXIS} tickLine={false} axisLine={false} width={52} />
          <Tooltip content={<MoneyTooltip labelFor={labelFor} />} cursor={{ stroke: "var(--border)" }} />
          <Area
            type="linear"
            dataKey="sales"
            name={labels.sales}
            stroke="none"
            fill={ANALYTICS_COLORS.sales}
            fillOpacity={0.12}
            isAnimationActive={false}
          />
          <Line type="linear" dataKey="sales" name={labels.sales} stroke={ANALYTICS_COLORS.sales} strokeWidth={2} dot={false} />
          <Line type="linear" dataKey="margin" name={labels.margin} stroke={ANALYTICS_COLORS.margin} strokeWidth={2} dot={false} />
          {zeroDays.map((day) => (
            <ReferenceDot key={day} x={day} y={0} r={4} fill={ANALYTICS_COLORS.noSales} stroke="var(--background)" strokeWidth={1.5} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Expenses and payroll per period, stacked bars (one "costs" view). */
export function CostsChart({
  points,
  granularity,
  labels,
  ariaLabel,
}: {
  points: SeriesPoint[];
  granularity: Granularity;
  labels: { expenses: string; payroll: string };
  ariaLabel: string;
}) {
  return (
    <div className="h-56 w-full sm:h-64" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <Axes granularity={granularity} />
          <Bar dataKey="expenses" name={labels.expenses} stackId="costs" fill={ANALYTICS_COLORS.expenses} maxBarSize={32} />
          <Bar dataKey="payroll" name={labels.payroll} stackId="costs" fill={ANALYTICS_COLORS.payroll} radius={[4, 4, 0, 0]} maxBarSize={32} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A tiny trend line for a KPI card (no axes; decorative). */
export function Sparkline({ values, color, className }: { values: number[]; color: string; className?: string }) {
  if (values.length < 2) return null;
  const width = 64;
  const height = 20;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={className} aria-hidden focusable="false">
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
