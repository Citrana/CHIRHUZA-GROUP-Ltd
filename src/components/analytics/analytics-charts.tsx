"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
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

type Series = { key: keyof Omit<SeriesPoint, "start">; label: string; color: string };

/** Short axis labels: "1 Oct" per day/week, "Oct 2026" per month. */
function useBucketLabel(granularity: "day" | "week" | "month") {
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
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{labelFor(label)}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 tabular-nums">
          <span className="inline-block size-2 rounded-full" style={{ background: p.color }} aria-hidden />
          {p.name}: {formatMoney(p.value ?? 0, "USD", locale)}
        </p>
      ))}
    </div>
  );
}

const AXIS = { fontSize: 11, fill: "var(--muted-foreground)" };

/**
 * One chart of money per period: an area for the first series (optionally
 * with a line for the second), or bars. Colours come from the theme's
 * --chart-* tokens, so light and dark mode both work.
 */
export function MoneyChart({
  points,
  granularity,
  series,
  kind,
}: {
  points: SeriesPoint[];
  granularity: "day" | "week" | "month";
  series: Series[];
  kind: "area" | "bar";
}) {
  const labelFor = useBucketLabel(granularity);
  const compact = useCompactMoney();
  const common = {
    data: points,
    margin: { top: 8, right: 8, bottom: 0, left: 0 },
  };
  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
      <XAxis dataKey="start" tickFormatter={labelFor} tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
      <YAxis tickFormatter={compact} tick={AXIS} tickLine={false} axisLine={false} width={52} />
      <Tooltip content={<MoneyTooltip labelFor={labelFor} />} cursor={{ fill: "var(--muted)", opacity: 0.4 }} />
    </>
  );
  return (
    <div className="h-56 w-full sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        {kind === "area" ? (
          <ComposedChart {...common}>
            {axes}
            <Area
              type="monotone"
              dataKey={series[0].key}
              name={series[0].label}
              stroke={series[0].color}
              fill={series[0].color}
              fillOpacity={0.15}
              strokeWidth={2}
            />
            {series[1] ? (
              <Line type="monotone" dataKey={series[1].key} name={series[1].label} stroke={series[1].color} strokeWidth={2} dot={false} />
            ) : null}
          </ComposedChart>
        ) : (
          <BarChart {...common}>
            {axes}
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={32} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
