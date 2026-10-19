import { businessDayOf } from "../../convex/lib/time";

/**
 * The stock report's filters and their URL state (pure, so it's tested
 * without a browser): status pills, the "Show" choice (selling well /
 * slowly / not selling) and the period it looks at. The rate behind "Show"
 * is units sold in the period / units bought in.
 */

/** The one place to tune what counts as selling well or slowly. */
export const MOVEMENT_THRESHOLDS = {
  /** At or above: selling well. */
  fastSellThrough: 0.5,
  /** Below (with some left and some sold): selling slowly. */
  slowSellThrough: 0.2,
} as const;

/** The "Show" choices (none = all products). They don't overlap. */
export const SHOWS = ["well", "slow", "not_selling"] as const;
export type Show = (typeof SHOWS)[number];

export const STOCK_STATUSES = ["in_stock", "low", "out", "never"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Status pills. "available" = in stock, running low included. */
export const STATUS_FILTERS = ["available", "low", "out", "never"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const PERIODS = ["30", "90", "all"] as const;
export type Period = (typeof PERIODS)[number];

export const STOCK_VIEWS = ["product", "lot", "holder"] as const;
export type StockView = (typeof STOCK_VIEWS)[number];

/** Sortable columns: Left, Sold (in the period), Last sold. */
export const SORT_KEYS = ["left", "sold", "lastSold"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type MovementRow = { received: number; sold: number; soldInPeriod: number; onHand: number };

/** Sold in the period / bought in (0..1+), or null when nothing was bought in. */
export function sellThrough(row: MovementRow): number | null {
  return row.received > 0 ? row.soldInPeriod / row.received : null;
}

/** Bought in, but not one sold ever. */
export function neverSold(row: MovementRow): boolean {
  return row.received > 0 && row.sold === 0;
}

/** Whether a row matches a "Show" choice (each row matches at most one). */
export function matchesShow(row: MovementRow, show: Show): boolean {
  const rate = sellThrough(row);
  switch (show) {
    case "well":
      return rate !== null && rate >= MOVEMENT_THRESHOLDS.fastSellThrough;
    case "slow":
      return row.onHand > 0 && row.soldInPeriod > 0 && rate !== null && rate < MOVEMENT_THRESHOLDS.slowSellThrough;
    case "not_selling":
      return (row.onHand > 0 && row.soldInPeriod === 0) || neverSold(row);
  }
}

export function matchesStatus(status: StockStatus, filter: StatusFilter): boolean {
  return filter === "available" ? status === "in_stock" || status === "low" : status === filter;
}

/** Whole business days from `ms` to `now` (Africa/Lubumbashi), 0 = today. */
export function businessDaysAgo(ms: number, now: number): number {
  const day = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((day(businessDayOf(now)) - day(businessDayOf(ms))) / 86_400_000);
}

/** "today", "yesterday", "4 days ago", "2 months ago" in the given locale. */
export function relativeDay(ms: number, now: number, locale: string): string {
  const days = businessDaysAgo(ms, now);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (days < 30) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.floor(days / 30), "month");
  return rtf.format(-Math.floor(days / 365), "year");
}

/** The report's filters, as kept in the URL query. */
export type StockFilters = {
  view: StockView;
  /** "" = all statuses. */
  status: StatusFilter | "";
  /** "" = all products. */
  show: Show | "";
  /** Only applies with a "Show" choice (see `effectivePeriod`). */
  period: Period;
  q: string;
  /** "" = by name (the server's order). */
  sort: SortKey | "";
  desc: boolean;
};

export const DEFAULT_FILTERS: StockFilters = {
  view: "product",
  status: "",
  show: "",
  period: "30",
  q: "",
  sort: "",
  desc: true,
};

const pick = <T extends string>(values: readonly T[], value: string | null, fallback: T): T =>
  value !== null && (values as readonly string[]).includes(value) ? (value as T) : fallback;

/** Reads filters from a query string; unknown values fall back to defaults. */
export function parseStockFilters(params: URLSearchParams): StockFilters {
  // Older links said "in_stock" for what is now "available".
  const status = params.get("status") === "in_stock" ? "available" : params.get("status");
  return {
    view: pick(STOCK_VIEWS, params.get("view"), DEFAULT_FILTERS.view),
    status: pick<StatusFilter | "">(STATUS_FILTERS, status, ""),
    show: pick<Show | "">(SHOWS, params.get("show"), ""),
    period: pick(PERIODS, params.get("period"), DEFAULT_FILTERS.period),
    q: params.get("q") ?? "",
    sort: pick<SortKey | "">(SORT_KEYS, params.get("sort"), ""),
    desc: params.get("dir") !== "asc",
  };
}

/** The query string for some filters; defaults are left out. */
export function stockFiltersQuery(filters: StockFilters): string {
  const params = new URLSearchParams();
  if (filters.view !== DEFAULT_FILTERS.view) params.set("view", filters.view);
  if (filters.status) params.set("status", filters.status);
  if (filters.show) params.set("show", filters.show);
  if (filters.period !== DEFAULT_FILTERS.period) params.set("period", filters.period);
  if (filters.q.trim()) params.set("q", filters.q);
  if (filters.sort) {
    params.set("sort", filters.sort);
    params.set("dir", filters.desc ? "desc" : "asc");
  }
  return params.toString();
}

/** The period "Sold" counts: the chosen one with a "Show" choice, else all time. */
export function effectivePeriod(filters: StockFilters): Period {
  return filters.show ? filters.period : "all";
}

/** The period as the query's `periodDays` (undefined = all time). */
export function periodDays(period: Period): 30 | 90 | undefined {
  return period === "all" ? undefined : period === "90" ? 90 : 30;
}

/** What the report filters, searches and sorts on. */
export type ReportRowLike = MovementRow & {
  status: StockStatus;
  name: string;
  sku: string;
  lengthInches: number | null;
  sizeName: string | null;
  colourName: string | null;
  lastSoldAt: number | null;
};

function matchesSearch(row: ReportRowLike, q: string): boolean {
  const term = q.trim().toLowerCase();
  if (!term) return true;
  return [row.name, row.sku, row.lengthInches === null ? null : String(row.lengthInches), row.sizeName, row.colourName]
    .some((v) => v !== null && v.toLowerCase().includes(term));
}

const sortValue: Record<SortKey, (row: ReportRowLike) => number | null> = {
  left: (r) => r.onHand,
  sold: (r) => r.soldInPeriod,
  lastSold: (r) => r.lastSoldAt,
};

/**
 * The rows a set of filters shows, in order (status AND show AND search;
 * sorted by the chosen column, empty values last, else as given), plus
 * faceted counts: each status pill counted under the other filters, and
 * each "Show" choice likewise - so a number matches what a click shows.
 */
export function filterReportRows<T extends ReportRowLike>(rows: readonly T[], filters: StockFilters) {
  const searched = rows.filter((r) => matchesSearch(r, filters.q));
  const byShow = filters.show ? searched.filter((r) => matchesShow(r, filters.show as Show)) : searched;
  const byStatus = filters.status ? searched.filter((r) => matchesStatus(r.status, filters.status as StatusFilter)) : searched;
  const visible = filters.status ? byShow.filter((r) => matchesStatus(r.status, filters.status as StatusFilter)) : byShow;

  const statusCounts = Object.fromEntries(
    STATUS_FILTERS.map((f) => [f, byShow.filter((r) => matchesStatus(r.status, f)).length]),
  ) as Record<StatusFilter, number>;
  const showCounts = Object.fromEntries(SHOWS.map((m) => [m, byStatus.filter((r) => matchesShow(r, m)).length])) as Record<
    Show,
    number
  >;

  if (filters.sort) {
    const value = sortValue[filters.sort];
    const sign = filters.desc ? -1 : 1;
    visible.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (x - y) * sign;
    });
  }
  return { rows: visible, statusCounts, allCount: byShow.length, showCounts, allProductsCount: byStatus.length };
}
