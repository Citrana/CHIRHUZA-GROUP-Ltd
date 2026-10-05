"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import type { api } from "../../../convex/_generated/api";
import { formatMoney } from "../../../convex/lib/money";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Button } from "@/components/ui/button";
import { downloadCsv } from "@/lib/csv";

type Report = FunctionReturnType<typeof api.analytics.getProductSales>;
type Row = Report["rows"][number];

/**
 * The "Products sold" report on Analytics: every product sold in the
 * chosen range and location (from the rollups), sortable and searchable,
 * with totals and a CSV download of the rows shown.
 */
export function ProductsSoldTable({
  report,
  fileName,
}: {
  /** undefined while loading. */
  report: Report | undefined;
  /** CSV file name, without extension. */
  fileName: string;
}) {
  const t = useTranslations("Analytics.productsSold");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const [search, setSearch] = useState("");

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const pct = (value: number | null) => (value === null ? "—" : `${value.toLocaleString(locale)} %`);
  const details = (r: Row) =>
    [r.lengthInches !== null ? tProducts("inches", { inches: r.lengthInches }) : null, r.sizeName, r.colourName]
      .filter(Boolean)
      .join(" · ");
  const label = (r: Row) => [r.name ?? "—", details(r)].filter(Boolean).join(" · ");

  const query = search.trim().toLowerCase();
  const rows = report?.rows.filter(
    (r) => !query || label(r).toLowerCase().includes(query) || (r.sku ?? "").toLowerCase().includes(query),
  );

  const columns: DataTableColumn<Row>[] = [
    {
      id: "product",
      accessorFn: (r) => label(r),
      header: t("productHeader"),
      enableSorting: true,
      cell: ({ row }) => (
        <span className="block min-w-40">
          <span className="block font-medium">{label(row.original)}</span>
          <span className="block text-xs text-muted-foreground">{row.original.sku}</span>
        </span>
      ),
    },
    { id: "units", accessorFn: (r) => r.unitsSold, header: t("unitsHeader"), enableSorting: true, meta: { className: "tabular-nums font-medium" } },
    {
      id: "revenue",
      accessorFn: (r) => r.revenue,
      header: t("revenueHeader"),
      enableSorting: true,
      cell: ({ row }) => money(row.original.revenue),
      meta: { className: "tabular-nums whitespace-nowrap" },
    },
    {
      id: "cost",
      accessorFn: (r) => r.cost,
      header: t("costHeader"),
      enableSorting: true,
      cell: ({ row }) => money(row.original.cost),
      meta: { hideBelow: "lg", className: "tabular-nums whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "margin",
      accessorFn: (r) => r.margin,
      header: t("marginHeader"),
      enableSorting: true,
      cell: ({ row }) => money(row.original.margin),
      meta: { hideBelow: "sm", className: "tabular-nums whitespace-nowrap" },
    },
    {
      id: "marginPct",
      accessorFn: (r) => r.marginPct ?? -Infinity,
      header: t("marginPctHeader"),
      enableSorting: true,
      cell: ({ row }) => pct(row.original.marginPct),
      meta: { hideBelow: "md", className: "tabular-nums whitespace-nowrap text-muted-foreground" },
    },
  ];

  function download() {
    if (!rows) return;
    downloadCsv(`${fileName}.csv`, [
      [t("csv.product"), t("csv.sku"), t("csv.details"), t("csv.units"), t("csv.revenue"), t("csv.cost"), t("csv.margin"), t("csv.marginPct")],
      ...rows.map((r) => [
        r.name,
        r.sku,
        details(r),
        r.unitsSold,
        (r.revenue / 100).toFixed(2),
        (r.cost / 100).toFixed(2),
        (r.margin / 100).toFixed(2),
        r.marginPct,
      ]),
    ]);
  }

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => r.productId}
        emptyMessage={t("empty")}
        search={{ value: search, onChange: setSearch, placeholder: t("searchPlaceholder") }}
        toolbar={
          <Button type="button" variant="outline" className="min-h-10" disabled={!rows || rows.length === 0} onClick={download}>
            <Download aria-hidden />
            {t("download")}
          </Button>
        }
        initialSorting={[{ id: "units", desc: true }]}
        renderCard={(r) => (
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block font-medium">{r.name ?? "—"}</span>
              <span className="block text-xs text-muted-foreground">{[r.sku, details(r)].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-semibold tabular-nums">{t("units", { count: r.unitsSold })}</span>
              <span className="block text-sm tabular-nums">{money(r.revenue)}</span>
              <span className="block text-xs text-muted-foreground tabular-nums">
                {t("marginHeader")} {money(r.margin)}
              </span>
            </span>
          </div>
        )}
      />
      {report && report.rows.length > 0 ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <div className="flex gap-1.5">
            <dt className="font-medium">{t("total")}</dt>
            <dd className="tabular-nums">{t("units", { count: report.totals.unitsSold })}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">{t("revenueHeader")}</dt>
            <dd className="font-medium tabular-nums">{money(report.totals.revenue)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">{t("marginHeader")}</dt>
            <dd className="font-medium tabular-nums">{money(report.totals.margin)}</dd>
          </div>
        </dl>
      ) : null}
      {report?.truncated ? <p className="text-sm text-destructive">{t("truncated")}</p> : null}
    </div>
  );
}
