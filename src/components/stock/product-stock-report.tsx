"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useConvex, useQuery, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { PRODUCT_PROFILES } from "../../../convex/lib/products";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProductPhoto } from "@/components/products/product-photo";
import { ProductStockHistory } from "@/components/stock/product-stock-history";
import { downloadCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";

type ReportRow = PaginatedQueryItem<typeof api.inventory.productReport>;
type Status = ReportRow["status"];
const STATUSES = ["in_stock", "low", "out", "never"] as const;

const STATUS_VARIANT: Record<Status, "secondary" | "outline" | "destructive" | "default"> = {
  in_stock: "secondary",
  low: "default",
  out: "destructive",
  never: "outline",
};

/**
 * The stock report ("By product"): every product of the service - in
 * stock, low, out (and since when), never stocked - with received / sold /
 * on hand and last dates. Status chips, search, CSV download; open a
 * product for where it is and its history.
 */
export function ProductStockReport({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Inventory.report");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const convex = useConvex();
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  // Opens on what we have: products in stock first.
  const [status, setStatus] = useState<Status | "">("in_stock");
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState(false);
  const counts = useQuery(api.inventory.statusCounts, { businessUnitKey: service });
  const { results, pagination } = useCursorPaginatedQuery(api.inventory.productReport, {
    businessUnitKey: service,
    ...(status ? { status } : {}),
    ...(search.trim() ? { search } : {}),
  });

  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const date = (ms: number | null) => (ms === null ? "—" : day.format(ms));
  const details = (r: Pick<ReportRow, "sku" | "lengthInches" | "sizeName" | "colourName">) =>
    [r.sku, r.lengthInches !== null ? tProducts("inches", { inches: r.lengthInches }) : null, r.sizeName, r.colourName]
      .filter(Boolean)
      .join(" · ");
  const statusBadge = (r: ReportRow) => (
    <span className="flex flex-col items-start gap-0.5">
      <Badge variant={STATUS_VARIANT[r.status]}>{t(`statuses.${r.status}`)}</Badge>
      {r.status === "out" && r.outOfStockSince !== null ? (
        <span className="text-xs text-muted-foreground">{t("since", { date: date(r.outOfStockSince) })}</span>
      ) : null}
    </span>
  );

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
    {
      id: "onHand",
      header: t("onHandHeader"),
      cell: ({ row }) => row.original.onHand,
      meta: { className: "tabular-nums font-medium" },
    },
    { id: "sold", header: t("soldHeader"), cell: ({ row }) => row.original.sold, meta: { hideBelow: "sm", className: "tabular-nums" } },
    {
      id: "received",
      header: t("receivedHeader"),
      cell: ({ row }) => row.original.received,
      meta: { hideBelow: "md", className: "tabular-nums text-muted-foreground" },
    },
    {
      id: "lastSold",
      header: t("lastSoldHeader"),
      cell: ({ row }) => date(row.original.lastSoldAt),
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
  ];

  async function download() {
    setDownloading(true);
    try {
      const rows = await convex.query(api.inventory.productReportExport, {
        businessUnitKey: service,
        ...(status ? { status } : {}),
      });
      downloadCsv(`stock-${service}-${businessDayOf(Date.now())}.csv`, [
        [t("csv.product"), t("csv.sku"), t("csv.details"), t("csv.status"), t("csv.onHand"), t("csv.received"), t("csv.sold"), t("csv.lastReceived"), t("csv.lastSold"), t("csv.outSince"), t("csv.threshold")],
        ...rows.map((r) => [
          r.name,
          r.sku,
          [r.lengthInches !== null ? `${r.lengthInches}″` : null, r.sizeName, r.colourName].filter(Boolean).join(" · "),
          t(`statuses.${r.status}`),
          r.onHand,
          r.received,
          r.sold,
          r.lastReceivedAt === null ? null : businessDayOf(r.lastReceivedAt),
          r.lastSoldAt === null ? null : businessDayOf(r.lastSoldAt),
          r.outOfStockSince === null ? null : businessDayOf(r.outOfStockSince),
          r.lowStockThreshold,
        ]),
      ]);
    } finally {
      setDownloading(false);
    }
  }

  const chip = (value: Status | "", label: string, count?: number) => (
    <button
      key={value || "all"}
      type="button"
      aria-pressed={status === value}
      onClick={() => setStatus(value)}
      className={cn(
        "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm",
        status === value ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
      )}
    >
      {label}
      {count !== undefined ? <span className="tabular-nums opacity-80">{count}</span> : null}
    </button>
  );
  const total = counts ? counts.in_stock + counts.low + counts.out + counts.never : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("statusHeader")}>
        {STATUSES.map((s) => chip(s, t(`statuses.${s}`), counts?.[s]))}
        {chip("", t("all"), total)}
        <Button type="button" variant="outline" className="ml-auto min-h-10" disabled={downloading} onClick={download}>
          <Download aria-hidden />
          {t("download")}
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(r) => r.productId}
        emptyMessage={t("empty")}
        search={{ value: search, onChange: setSearch, placeholder: t("searchPlaceholder") }}
        pagination={{ mode: "server", ...pagination }}
        renderExpanded={(r) => <ProductStockHistory productId={r.productId} threshold={r.lowStockThreshold} />}
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
            <span className="shrink-0 text-right">
              <span className="block text-lg font-semibold tabular-nums">{r.onHand}</span>
              <span className="block text-xs text-muted-foreground">{t("soldCount", { count: r.sold })}</span>
            </span>
          </div>
        )}
      />
    </div>
  );
}
