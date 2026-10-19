"use client";

import { useState } from "react";
import { Building2, ChevronDown, Download, FileSpreadsheet, FileText, MapPin, User } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import type { HolderType } from "../../../convex/lib/inventory";
import { formatMoney } from "../../../convex/lib/money";
import { businessDayOf } from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { ProductStockReport, type ReportRow } from "@/components/stock/product-stock-report";
import { useStockFilters } from "@/components/stock/use-stock-filters";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";
import { downloadCsv } from "@/lib/csv";
import { renderPdf } from "@/lib/pdf/document";
import { stockSellingValue } from "@/lib/stock-value";
import { stockPdfContent } from "@/lib/stock-pdf";
import { STOCK_VIEWS, effectivePeriod, filterReportRows, periodDays, type StatusFilter } from "@/lib/stock-movement";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type Overview = FunctionReturnType<typeof api.inventory.overview>;
type ProductRow = Overview["byProduct"][number];
type LotRow = Overview["byLot"][number];
type HolderRow = Overview["byHolder"][number];
type Holder = HolderRow["holder"];
type Product = ProductRow["product"];

const HOLDER_ICONS: Record<HolderType, typeof Building2> = {
  business: Building2,
  location: MapPin,
  user: User,
};

function useHolderLabel() {
  const t = useTranslations("Inventory");
  return (holder: Holder) => (holder.type === "business" ? t("businessHolder") : holder.name);
}

function HolderName({ holder }: { holder: Holder }) {
  const label = useHolderLabel();
  const Icon = HOLDER_ICONS[holder.type];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{label(holder)}</span>
    </span>
  );
}

function ProductName({ product }: { product: Product }) {
  const tProducts = useTranslations("Products");
  return (
    <div className="min-w-36">
      <p className="font-medium">{product.name ?? "—"}</p>
      <p className="text-xs text-muted-foreground">
        {[
          product.sku,
          product.lengthInches !== null ? tProducts("inches", { inches: product.lengthInches }) : null, product.sizeName,
          product.colourName,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

/** A small "who has how many" list, used in expanded rows. */
function Breakdown({ rows }: { rows: { key: string; label: React.ReactNode; qty: number }[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
          <span className="min-w-0">{r.label}</span>
          <span className="font-medium tabular-nums">{r.qty}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stock on hand, by product, by lot or by holder (stock.view). */
export function StockOverview({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Inventory");
  const locale = useLocale();
  const holderLabel = useHolderLabel();
  const canView = useCan("stock.view");
  // View, report filters and sorting live in the URL (shareable, Back works).
  const [filters, setFilters] = useStockFilters();
  const view = filters.view;
  const counts = useQuery(api.inventory.statusCounts, canView ? { businessUnitKey: service } : "skip");
  const overview = useQuery(api.inventory.overview, canView ? { businessUnitKey: service } : "skip");
  // The full report (every product) for viewers of all locations.
  const showReport = view === "product" && overview !== undefined && overview.scope !== "own_location";
  // "Sold" counts the chosen period only while a "Show" choice is on.
  const period = effectivePeriod(filters);
  const days = periodDays(period);
  const reportRows = useQuery(
    api.inventory.productReportRows,
    canView && showReport ? { businessUnitKey: service, ...(days ? { periodDays: days } : {}) } : "skip",
  );
  // The stock report PDF is built in the browser from `overview` (nothing stored).
  const tUnits = useTranslations("BusinessUnits");
  const me = useQuery(api.users.getCurrentUser);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(false);
  // The card values stock at selling prices; products without one are listed on demand.
  const tProducts = useTranslations("Products");
  const canSetPrice = useCan("products.set_price");
  const [showUnpriced, setShowUnpriced] = useState(false);

  if (canView === undefined) return null;
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const qtyCol = { meta: { className: "whitespace-nowrap tabular-nums font-medium" } };

  const productColumns: DataTableColumn<ProductRow>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <ProductName product={row.original.product} /> },
    { id: "qty", header: t("onHandHeader"), cell: ({ row }) => row.original.qty, ...qtyCol },
    {
      id: "holders",
      header: t("whereHeader"),
      cell: ({ row }) => row.original.holders.map((h) => holderLabel(h.holder)).join(", "),
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    {
      id: "value",
      header: t("valueHeader"),
      cell: ({ row }) => money(row.original.value),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums" },
    },
  ];

  const lotColumns: DataTableColumn<LotRow>[] = [
    { id: "product", header: t("productHeader"), cell: ({ row }) => <ProductName product={row.original.product} /> },
    {
      id: "batch",
      header: t("lotHeader"),
      cell: ({ row }) => row.original.lot.batchNumber ?? "—",
      meta: { className: "whitespace-nowrap font-mono text-xs" },
    },
    {
      id: "unitCost",
      header: t("unitCostHeader"),
      cell: ({ row }) => money(row.original.lot.unitCost),
      meta: { hideBelow: "md", className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "received",
      header: t("receivedHeader"),
      cell: ({ row }) => row.original.lot.receivedQty,
      meta: { hideBelow: "lg", className: "tabular-nums text-muted-foreground" },
    },
    { id: "qty", header: t("onHandHeader"), cell: ({ row }) => row.original.qty, ...qtyCol },
  ];

  const holderColumns: DataTableColumn<HolderRow>[] = [
    { id: "holder", header: t("holderHeader"), cell: ({ row }) => <HolderName holder={row.original.holder} /> },
    {
      id: "type",
      header: t("holderTypeHeader"),
      cell: ({ row }) => t(`holderTypes.${row.original.holder.type}`),
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    {
      id: "lines",
      header: t("productsHeader"),
      cell: ({ row }) => t("lotCount", { count: row.original.lines.length }),
      meta: { hideBelow: "sm", className: "whitespace-nowrap text-muted-foreground" },
    },
    { id: "qty", header: t("onHandHeader"), cell: ({ row }) => row.original.qty, ...qtyCol },
    {
      id: "value",
      header: t("valueHeader"),
      cell: ({ row }) => money(row.original.value),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums" },
    },
  ];

  const totalQty = overview?.byHolder.reduce((s, h) => s + h.qty, 0) ?? 0;
  const selling = overview ? stockSellingValue(overview.byProduct) : { value: 0, unpriced: [] };
  const productLabel = (p: (typeof selling.unpriced)[number]) =>
    [p.name ?? "—", p.lengthInches !== null ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
      .filter(Boolean)
      .join(" · ");

  async function downloadPdf() {
    if (!overview) return;
    setPdfBusy(true);
    setPdfError(false);
    try {
      const content = stockPdfContent(overview, {
        t: (key, values) => t(key as Parameters<typeof t>[0], values),
        locale,
        serviceKey: service,
        serviceName: tUnits(service),
        downloadedBy: me?.name || me?.email || "-",
        now: Date.now(),
      });
      await renderPdf(content, (page, pages) => t("pdf.page", { page, pages }));
    } catch {
      setPdfError(true);
    } finally {
      setPdfBusy(false);
    }
  }

  /** The report rows on screen (same filters and order) as CSV. */
  function downloadReportCsv(rows: ReportRow[]) {
    const visible = filterReportRows(rows, filters).rows;
    const inPeriod = period !== "all";
    downloadCsv(`stock-${service}-${businessDayOf(Date.now())}${inPeriod ? `-${period}d` : ""}.csv`, [
      [
        t("report.csv.product"),
        t("report.csv.sku"),
        t("report.csv.details"),
        t("report.csv.status"),
        t("report.csv.onHand"),
        t("report.csv.received"),
        t("report.csv.sold"),
        ...(inPeriod ? [t(`report.csvSoldPeriod.${period}`)] : []),
        t("report.csv.lastReceived"),
        t("report.csv.lastSold"),
        t("report.csv.outSince"),
        t("report.csv.threshold"),
      ],
      ...visible.map((r) => [
          r.name,
          r.sku,
          [r.lengthInches !== null ? `${r.lengthInches}″` : null, r.sizeName, r.colourName].filter(Boolean).join(" · "),
          t(`report.statuses.${r.status}`),
          r.onHand,
          r.received,
          r.sold,
          ...(inPeriod ? [r.soldInPeriod] : []),
          r.lastReceivedAt === null ? null : businessDayOf(r.lastReceivedAt),
          r.lastSoldAt === null ? null : businessDayOf(r.lastSoldAt),
          r.outOfStockSince === null ? null : businessDayOf(r.outOfStockSince),
          r.lowStockThreshold,
        ]),
    ]);
  }
  const showStatus = (status: StatusFilter) => setFilters({ view: "product", status, show: "" });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="scroll-mt-20 font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {overview?.scope === "own_location" ? t("subtitleOwn") : t("subtitle")}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="min-h-11" disabled={!overview || pdfBusy} />}>
            <Download aria-hidden />
            {pdfBusy ? t("pdf.preparing") : t("export.label")}
            <ChevronDown className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={downloadPdf}>
              <FileText className="size-4 text-muted-foreground" aria-hidden />
              {t("export.pdf")}
            </DropdownMenuItem>
            {showReport ? (
              <DropdownMenuItem disabled={!reportRows} onClick={() => reportRows && downloadReportCsv(reportRows)}>
                <FileSpreadsheet className="size-4 text-muted-foreground" aria-hidden />
                {t("export.csv")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {pdfError ? (
        <p className="text-sm text-destructive" role="alert">
          {t("pdf.error")}
        </p>
      ) : null}

      {overview ? (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label={t("totalsLabel")}>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t("unitsOnHand")}</p>
            <p className="text-lg font-semibold tabular-nums">{totalQty}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t("stockValue")}</p>
            <p className="text-lg font-semibold tabular-nums">{money(selling.value)}</p>
            {selling.unpriced.length > 0 ? (
              <button
                type="button"
                aria-expanded={showUnpriced}
                aria-controls="unpriced-products"
                onClick={() => setShowUnpriced((open) => !open)}
                className="mt-1 inline-flex min-h-11 items-center gap-1 text-left text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
              >
                {t("unpricedNote", { count: selling.unpriced.length })}
                <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", showUnpriced && "rotate-180")} aria-hidden />
              </button>
            ) : null}
          </div>
          {showUnpriced && selling.unpriced.length > 0 ? (
            <div id="unpriced-products" className="col-span-2 rounded-lg sm:order-last sm:col-span-3 border border-amber-500/40 bg-amber-500/5 p-3">
              <ul className="flex flex-col divide-y divide-border text-sm">
                {selling.unpriced.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block font-medium">{productLabel(p)}</span>
                      <span className="block text-xs text-muted-foreground">{p.sku}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t("unpricedInStock", { count: p.qty })}</span>
                  </li>
                ))}
              </ul>
              {canSetPrice ? (
                <Link
                  href={`/${service}/products/prices`}
                  className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t("setPrices")}
                </Link>
              ) : null}
            </div>
          ) : null}
          {counts ? (
            <div className="col-span-2 rounded-lg border border-border p-3 sm:col-span-1">
              <p className="text-xs text-muted-foreground">{t("lowOutLabel")}</p>
              <p className="flex flex-wrap items-center text-lg font-semibold tabular-nums">
                <button
                  type="button"
                  aria-label={t("showLow")}
                  aria-pressed={view === "product" && filters.status === "low"}
                  onClick={() => showStatus("low")}
                  className={cn("-mx-1 min-h-11 rounded px-1 underline-offset-4 hover:underline", counts.low > 0 && "text-amber-600")}
                >
                  {t("lowCount", { count: counts.low })}
                </button>
                <span className="px-1.5 text-muted-foreground" aria-hidden>·</span>
                <button
                  type="button"
                  aria-label={t("showOut")}
                  aria-pressed={view === "product" && filters.status === "out"}
                  onClick={() => showStatus("out")}
                  className={cn("-mx-1 min-h-11 rounded px-1 underline-offset-4 hover:underline", counts.out > 0 && "text-destructive")}
                >
                  {t("outCount", { count: counts.out })}
                </button>
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <div role="radiogroup" aria-label={t("viewLabel")} className="inline-flex self-start rounded-lg border border-border p-1">
        {STOCK_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={view === v}
            onClick={() => setFilters({ view: v })}
            className={cn(
              "min-h-10 rounded-md px-3 text-sm font-medium",
              view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`views.${v}`)}
          </button>
        ))}
      </div>

      {showReport ? (
        // The full report: every product, finished and never-stocked too.
        <ProductStockReport service={service} rows={reportRows} filters={filters} setFilters={setFilters} />
      ) : view === "product" ? (
        <DataTable
          columns={productColumns}
          data={overview?.byProduct}
          getRowId={(r) => r.product.id}
          emptyMessage={t("empty")}
          renderExpanded={(r) => (
            <Breakdown
              rows={r.holders.map((h) => ({ key: h.holder.id, label: <HolderName holder={h.holder} />, qty: h.qty }))}
            />
          )}
          renderCard={(r) => (
            <div className="flex items-start justify-between gap-3">
              <ProductName product={r.product} />
              <div className="text-right">
                <p className="text-lg font-semibold tabular-nums">{r.qty}</p>
                <p className="text-xs text-muted-foreground">{money(r.value)}</p>
              </div>
            </div>
          )}
        />
      ) : view === "lot" ? (
        <DataTable
          columns={lotColumns}
          data={overview?.byLot}
          getRowId={(r) => r.lot.id}
          emptyMessage={t("empty")}
          renderExpanded={(r) => (
            <Breakdown
              rows={r.holders.map((h) => ({ key: h.holder.id, label: <HolderName holder={h.holder} />, qty: h.qty }))}
            />
          )}
          renderCard={(r) => (
            <div className="flex items-start justify-between gap-3">
              <div>
                <ProductName product={r.product} />
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.lot.batchNumber ?? "—"} · {money(r.lot.unitCost)} · {t("receivedCount", { count: r.lot.receivedQty })}
                </p>
              </div>
              <p className="text-lg font-semibold tabular-nums">{r.qty}</p>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={holderColumns}
          data={overview?.byHolder}
          getRowId={(r) => r.holder.id}
          emptyMessage={t("empty")}
          renderExpanded={(r) => (
            <Breakdown
              rows={r.lines.map((l) => ({
                key: l.lot.id,
                label: (
                  <span>
                    {l.product.name ?? "—"}{" "}
                    <span className="text-xs text-muted-foreground">
                      {[l.product.sku, l.lot.batchNumber].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                ),
                qty: l.qty,
              }))}
            />
          )}
          renderCard={(r) => (
            <div className="flex items-center justify-between gap-3">
              <div>
                <HolderName holder={r.holder} />
                <p className="text-xs text-muted-foreground">
                  {t("lotCount", { count: r.lines.length })} · {money(r.value)}
                </p>
              </div>
              <p className="text-lg font-semibold tabular-nums">{r.qty}</p>
            </div>
          )}
        />
      )}
      <p className="text-xs text-muted-foreground">{t("valueHint")}</p>
    </div>
  );
}
