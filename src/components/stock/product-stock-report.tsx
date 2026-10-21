"use client";

import { useState, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { PRODUCT_PROFILES } from "../../../convex/lib/products";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ProductPhoto } from "@/components/products/product-photo";
import { ProductStockHistory } from "@/components/stock/product-stock-history";
import type { SetStockFilters } from "@/components/stock/use-stock-filters";
import {
  PERIODS,
  SHOWS,
  STATUS_FILTERS,
  effectivePeriod,
  filterReportRows,
  neverSold,
  relativeDay,
  type Period,
  type Show,
  type SortKey,
  type StatusFilter,
  type StockFilters,
  type StockStatus,
} from "@/lib/stock-movement";
import { cn } from "@/lib/utils";

export type ReportRow = FunctionReturnType<typeof api.inventory.productReportRows>[number];

const STATUS_BADGE: Record<StockStatus, string> = {
  in_stock: "bg-secondary text-secondary-foreground",
  low: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  out: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  never: "bg-muted text-muted-foreground",
};

/** The phone Sort menu: URL `sort:dir` -> label key. */
const PHONE_SORTS = [
  { value: "", label: "name" },
  { value: "sold:desc", label: "soldDesc" },
  { value: "sold:asc", label: "soldAsc" },
  { value: "left:desc", label: "leftDesc" },
  { value: "left:asc", label: "leftAsc" },
  { value: "lastSold:desc", label: "lastSoldDesc" },
  { value: "lastSold:asc", label: "lastSoldAsc" },
] as const;

/** "11 left of 24" with a thin bar of what remains (amber when running low). */
function LeftOf({ row }: { row: ReportRow }) {
  const t = useTranslations("Inventory.report");
  if (row.received <= 0) return <span className="font-medium">{t("leftOnly", { left: row.onHand })}</span>;
  const share = Math.min(row.onHand / row.received, 1);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="whitespace-nowrap font-medium">{t("leftOf", { left: row.onHand, total: row.received })}</span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn("block h-full rounded-full", row.status === "low" ? "bg-amber-500" : "bg-primary/40")}
          style={{ width: `${share * 100}%` }}
        />
      </span>
    </span>
  );
}

/**
 * The stock report ("By product"): every product of the service -
 * available, running low, sold out (and since when), not received yet -
 * with what's left, what sold and the last sale. Status pills and the
 * "Show" choice combine; filters and sorting live in the URL (owned by
 * StockOverview, which also exports the visible rows as CSV).
 */
export function ProductStockReport({
  service,
  rows,
  filters,
  setFilters,
}: {
  service: BusinessUnitKey;
  /** `undefined` while loading. */
  rows: ReportRow[] | undefined;
  filters: StockFilters;
  setFilters: SetStockFilters;
}) {
  const t = useTranslations("Inventory.report");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const view = rows ? filterReportRows(rows, filters) : undefined;
  // "4 days ago" is counted from when the page opened.
  const [now] = useState(() => Date.now());
  const soldHeader = t(`soldPeriodHeader.${effectivePeriod(filters)}`);

  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const date = (ms: number | null) => (ms === null ? "—" : day.format(ms));
  const details = (r: Pick<ReportRow, "sku" | "lengthInches" | "sizeName" | "colourName">) =>
    [r.sku, r.lengthInches !== null ? tProducts("inches", { inches: r.lengthInches }) : null, r.sizeName, r.colourName]
      .filter(Boolean)
      .join(" · ");
  const statusBadge = (r: ReportRow) => (
    <span className="flex flex-col items-start gap-0.5">
      <Badge variant="outline" className={cn("border-transparent", STATUS_BADGE[r.status])}>
        {t(`statuses.${r.status}`)}
      </Badge>
      {r.status === "out" && r.outOfStockSince !== null ? (
        <span className="text-xs text-muted-foreground">{t("since", { date: date(r.outOfStockSince) })}</span>
      ) : null}
      {neverSold(r) ? (
        <span className="rounded-sm bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">{t("neverSold")}</span>
      ) : null}
    </span>
  );
  const lastSold = (ms: number | null) =>
    ms === null ? (
      <span>{t("never")}</span>
    ) : (
      <time dateTime={new Date(ms).toISOString()} title={date(ms)}>
        {relativeDay(ms, now, locale)}
      </time>
    );

  const sortable = (
    id: SortKey,
    header: string,
    value: (r: ReportRow) => number | null,
    cell: (r: ReportRow) => ReactNode,
    meta?: DataTableColumn<ReportRow>["meta"],
  ) =>
    ({
      id,
      header,
      accessorFn: (r: ReportRow) => value(r) ?? undefined,
      cell: ({ row }: { row: { original: ReportRow } }) => cell(row.original),
      enableSorting: true,
      meta: { align: "right", ...meta, className: cn("whitespace-nowrap tabular-nums", meta?.className) },
    }) as DataTableColumn<ReportRow>;

  const columns: DataTableColumn<ReportRow>[] = [
    {
      id: "product",
      header: t("productHeader"),
      cell: ({ row }) => (
        <span className="flex min-w-40 items-center gap-3">
          {withPhotos ? <ProductPhoto url={row.original.photoUrl} /> : null}
          <span className="min-w-0">
            <span className="block font-medium">{row.original.name}</span>
            <span className="block text-xs text-muted-foreground">{details(row.original)}</span>
          </span>
        </span>
      ),
    },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => statusBadge(row.original) },
    sortable("left", t("onHandHeader"), (r) => r.onHand, (r) => <LeftOf row={r} />),
    sortable("sold", soldHeader, (r) => r.soldInPeriod, (r) => r.soldInPeriod, { hideBelow: "sm" }),
    sortable("lastSold", t("lastSoldHeader"), (r) => r.lastSoldAt, (r) => lastSold(r.lastSoldAt), {
      hideBelow: "md",
      className: "text-muted-foreground",
    }),
  ];

  // Pills with nothing to show are hidden (All and the active one stay).
  const statusChip = (value: StatusFilter | "", label: string, count: number | undefined) =>
    value !== "" && count === 0 && filters.status !== value ? null : (
      <button
        key={value || "all"}
        type="button"
        aria-pressed={filters.status === value}
        onClick={() => setFilters({ status: value })}
        className={cn(
          "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm",
          filters.status === value ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
        )}
      >
        {label}
        {count !== undefined ? <span className="tabular-nums opacity-80">{count}</span> : null}
      </button>
    );
  const withCount = (label: string, count: number | undefined) => (count === undefined ? label : `${label} (${count})`);

  const filtered = filters.status !== "" || filters.show !== "" || filters.q.trim() !== "";
  const clearFilters = () => setFilters({ status: "", show: "", q: "" });
  const emptyMessage = filtered ? (
    <span className="flex flex-col items-center gap-3">
      <span>{t("emptyFiltered")}</span>
      <Button type="button" variant="outline" className="min-h-11" onClick={clearFilters}>
        {t("clearFilters")}
      </Button>
    </span>
  ) : (
    t("empty")
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="shrink-0">{t("showLabel")}</span>
        <NativeSelect
          className="h-10 w-auto"
          value={filters.show}
          onChange={(e) => setFilters({ show: e.target.value as Show | "" })}
        >
          <option value="">{withCount(t("shows.all"), view?.allProductsCount)}</option>
          {SHOWS.filter((s) => filters.show === s || view === undefined || view.showCounts[s] > 0).map((s) => (
            <option key={s} value={s}>
              {withCount(t(`shows.${s}`), view?.showCounts[s])}
            </option>
          ))}
        </NativeSelect>
      </label>
      {/* Phones get cards, not column headers: sorting lives here. */}
      <label className="flex items-center gap-2 text-sm text-muted-foreground md:hidden">
        <span className="shrink-0">{t("sortLabel")}</span>
        <NativeSelect
          className="h-10 w-auto"
          value={filters.sort ? `${filters.sort}:${filters.desc ? "desc" : "asc"}` : ""}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":") as [SortKey | "", string | undefined];
            setFilters({ sort, desc: dir !== "asc" });
          }}
        >
          {PHONE_SORTS.map(({ value, label }) => (
            <option key={value} value={value}>
              {t(`sorts.${label}`)}
            </option>
          ))}
        </NativeSelect>
      </label>
      {filters.show ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="shrink-0">{t("periodLabel")}</span>
          <NativeSelect
            className="h-10 w-auto"
            value={filters.period}
            onChange={(e) => setFilters({ period: e.target.value as Period })}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {t(`periods.${p}`)}
              </option>
            ))}
          </NativeSelect>
        </label>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("statusHeader")}>
        {statusChip("", t("all"), view?.allCount)}
        {STATUS_FILTERS.map((s) => statusChip(s, t(`statusFilters.${s}`), view?.statusCounts[s]))}
      </div>
      <DataTable
        columns={columns}
        data={view?.rows}
        getRowId={(r) => r.productId}
        emptyMessage={emptyMessage}
        search={{
          value: filters.q,
          onChange: (q) => setFilters({ q }, { replace: true }),
          placeholder: t("searchPlaceholder"),
          className: "sm:max-w-sm sm:flex-1",
        }}
        toolbar={toolbar}
        sorting={filters.sort ? [{ id: filters.sort, desc: filters.desc }] : []}
        onSortingChange={(sorting) => {
          const next = sorting[0];
          // A first click on a column sorts it high to low.
          const desc = next && next.id !== filters.sort ? true : (next?.desc ?? true);
          setFilters({ sort: (next?.id as SortKey | undefined) ?? "", desc });
        }}
        manualSorting
        sortIconsOnHover
        renderExpanded={(r) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm tabular-nums">
              <span className="text-muted-foreground">{t("receivedHeader")}</span> <span className="font-medium">{r.received}</span>
              <span className="px-2 text-muted-foreground" aria-hidden>·</span>
              <span className="text-muted-foreground">{t("soldAllTime")}</span> <span className="font-medium">{r.sold}</span>
            </p>
            <ProductStockHistory productId={r.productId} threshold={r.lowStockThreshold} />
          </div>
        )}
        renderCard={(r) => (
          <div className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-center gap-3">
              {withPhotos ? <ProductPhoto url={r.photoUrl} size="md" /> : null}
              <span className="min-w-0">
                <span className="block font-medium">{r.name}</span>
                <span className="block text-xs text-muted-foreground">{details(r)}</span>
                <span className="mt-1 block">{statusBadge(r)}</span>
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1 text-right tabular-nums">
              <LeftOf row={r} />
              <span className="text-xs text-muted-foreground">
                {soldHeader}: {r.soldInPeriod}
              </span>
            </span>
          </div>
        )}
      />
    </div>
  );
}
