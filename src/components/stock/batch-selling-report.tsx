"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import type { api } from "../../../convex/_generated/api";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCan } from "@/lib/use-can";

export type SellingReport = NonNullable<FunctionReturnType<typeof api.stockBatches.sellingReport>>;
type Line = SellingReport["lines"][number];
type SaleLine = SellingReport["saleLines"][number];
type HolderRow = SellingReport["remainingByHolder"][number];
type Detail = "expected" | "sold" | "remaining" | "damaged" | "differences";

type ProductLabel = { name: string | null; lengthInches: number | null; sizeName: string | null; colourName: string | null };

/** A stat card that opens its detail pop-up. */
function StatButton({ label, children, details, onClick }: { label: string; children: ReactNode; details: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-11 flex-col items-start rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
      <span className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-primary group-hover:underline">
        {details}
        <ChevronRight className="size-3" aria-hidden />
      </span>
    </button>
  );
}

/**
 * A batch's value at selling prices (stockBatches.sellingReport): expected
 * from the purchased units, sold so far, what remains, damaged or missing,
 * with a warning naming the products that have no selling price.
 */
export function BatchSellingReport({ report, service }: { report: SellingReport; service: string }) {
  const t = useTranslations("StockBatches.selling");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canSetPrice = useCan("products.set_price");
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const pcs = (count: number) => t("pieces", { count });
  const tInventory = useTranslations("Inventory");
  const [open, setOpen] = useState<Detail | null>(null);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const label = (p: ProductLabel) =>
    [p.name ?? "—", p.lengthInches !== null ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
      .filter(Boolean)
      .join(" · ");
  const notReceived = <span className="text-muted-foreground">{t("notReceived")}</span>;
  const { totals } = report;
  // Positive: sold below today's prices; negative: above.
  const signed = (cents: number) =>
    cents === 0 ? money(0) : t(cents > 0 ? "below" : "above", { amount: money(Math.abs(cents)) });
  const differing = report.saleLines.filter((l) => l.difference !== null && l.difference !== 0);
  const reason = (l: SaleLine) => {
    const parts = [
      l.discountReason,
      l.saleDiscountReason !== null ? t("wholeSaleDiscount", { reason: l.saleDiscountReason }) : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : <span className="text-muted-foreground">{t("noReason")}</span>;
  };
  const productCell = (p: ProductLabel & { sku: string | null }) => (
    <span className="block min-w-36">
      <span className="block font-medium">{label(p)}</span>
      <span className="block text-xs text-muted-foreground">{p.sku}</span>
    </span>
  );
  const num = { align: "right", className: "tabular-nums whitespace-nowrap" } as const;
  const hiddenNote = report.saleLinesHidden ? <p className="text-sm text-muted-foreground">{t("salesHidden")}</p> : null;
  const totalLine = (...parts: ReactNode[]) => (
    <p className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-sm tabular-nums">
      <span className="font-medium">{t("total")}</span>
      {parts.map((part, i) => (
        <span key={i}>{part}</span>
      ))}
    </p>
  );

  const saleColumns: DataTableColumn<SaleLine>[] = [
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          <span className="block">{day.format(row.original.createdAt)}</span>
          <span className="block text-xs text-muted-foreground">
            {row.original.saleNumber} · {row.original.locationName}
          </span>
        </span>
      ),
    },
    { id: "product", header: t("productHeader"), cell: ({ row }) => productCell(row.original) },
    { id: "qty", header: t("qtyHeader"), cell: ({ row }) => row.original.qty, meta: num },
    { id: "unitPrice", header: t("unitPriceHeader"), cell: ({ row }) => money(row.original.unitPrice), meta: { ...num, hideBelow: "md" } },
    { id: "amount", header: t("amountHeader"), cell: ({ row }) => money(row.original.amount), meta: { ...num, className: `${num.className} font-medium` } },
  ];
  const saleCard = (l: SaleLine, extra?: ReactNode) => (
    <div className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between gap-3">
        <span className="font-medium">{label(l)}</span>
        <span className="tabular-nums font-medium">{money(l.amount)}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        {[day.format(l.createdAt), l.saleNumber, l.locationName].join(" · ")}
      </span>
      <span className="text-xs tabular-nums">
        {pcs(l.qty)} × {money(l.unitPrice)}
      </span>
      {extra}
    </div>
  );

  const differenceColumns: DataTableColumn<SaleLine>[] = [
    saleColumns[0],
    saleColumns[1],
    saleColumns[2],
    {
      id: "priceAtSale",
      header: t("priceAtSaleHeader"),
      cell: ({ row }) => (row.original.priceAtSale === null ? "—" : money(row.original.priceAtSale)),
      meta: { ...num, hideBelow: "lg" },
    },
    { id: "todayPrice", header: t("todayPriceHeader"), cell: ({ row }) => (row.original.todayPrice === null ? "—" : money(row.original.todayPrice)), meta: { ...num, hideBelow: "md" } },
    { id: "soldFor", header: t("soldForHeader"), cell: ({ row }) => money(row.original.amount), meta: num },
    { id: "difference", header: t("differenceHeader"), cell: ({ row }) => signed(row.original.difference ?? 0), meta: { ...num, className: `${num.className} font-medium` } },
    { id: "reason", header: t("reasonHeader"), cell: ({ row }) => <span className="block min-w-40">{reason(row.original)}</span> },
  ];

  const lineColumns = (cols: DataTableColumn<Line>[]): DataTableColumn<Line>[] => [
    { id: "product", header: t("productHeader"), cell: ({ row }) => productCell(row.original) },
    ...cols,
  ];
  const holderLabel = (h: HolderRow) => (h.type === "business" ? tInventory("businessHolder") : h.name);
  const holderColumns: DataTableColumn<HolderRow>[] = [
    { id: "holder", header: t("holderHeader"), cell: ({ row }) => holderLabel(row.original) },
    { id: "qty", header: t("qtyHeader"), cell: ({ row }) => row.original.qty, meta: num },
    { id: "value", header: t("valueHeader"), cell: ({ row }) => money(row.original.value), meta: num },
  ];

  const details: Record<Detail, { title: string; help: string; body: ReactNode }> = {
    expected: {
      title: t("expected"),
      help: t("expectedHelp"),
      body: (
        <>
          <DataTable
            columns={lineColumns([
              { id: "purchased", header: t("purchasedHeader"), cell: ({ row }) => row.original.purchased, meta: num },
              { id: "price", header: t("todayPriceHeader"), cell: ({ row }) => (row.original.price === null ? "—" : money(row.original.price)), meta: num },
              { id: "expected", header: t("expectedHeader"), cell: ({ row }) => (row.original.expected === null ? "—" : money(row.original.expected)), meta: num },
            ])}
            data={report.lines}
            getRowId={(l) => l.itemId}
            renderCard={(l) => (
              <div className="flex justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium">{label(l)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {pcs(l.purchased)} × {l.price === null ? "—" : money(l.price)}
                  </span>
                </span>
                <span className="tabular-nums font-medium">{l.expected === null ? "—" : money(l.expected)}</span>
              </div>
            )}
          />
          {totalLine(t("amountPieces", { amount: money(totals.expected), pieces: pcs(totals.purchased) }))}
        </>
      ),
    },
    sold: {
      title: t("sold"),
      help: t("soldHelp"),
      body: (
        <>
          {hiddenNote}
          {report.saleLinesHidden ? null : (
            <DataTable columns={saleColumns} data={report.saleLines} getRowId={(l) => l.saleItemId} emptyMessage={t("noSales")} renderCard={(l) => saleCard(l)} />
          )}
          {totalLine(t("amountPieces", { amount: money(totals.soldAmount), pieces: pcs(totals.soldQty) }))}
        </>
      ),
    },
    remaining: {
      title: t("remaining"),
      help: t("remainingHelp"),
      body: (
        <>
          <h3 className="text-sm font-semibold">{t("byHolder")}</h3>
          <DataTable
            columns={holderColumns}
            data={report.remainingByHolder}
            getRowId={(h) => h.holderId}
            pagination={false}
            emptyMessage={t("nothingLeft")}
            renderCard={(h) => (
              <div className="flex justify-between gap-3 text-sm tabular-nums">
                <span className="font-medium">{holderLabel(h)}</span>
                <span>{t("amountPieces", { amount: money(h.value), pieces: pcs(h.qty) })}</span>
              </div>
            )}
          />
          <h3 className="text-sm font-semibold">{t("byProduct")}</h3>
          <DataTable
            columns={lineColumns([
              { id: "remaining", header: t("qtyHeader"), cell: ({ row }) => row.original.remaining ?? 0, meta: num },
              { id: "value", header: t("valueHeader"), cell: ({ row }) => (row.original.remainingValue === null ? "—" : money(row.original.remainingValue)), meta: num },
            ])}
            data={report.lines.filter((l) => (l.remaining ?? 0) > 0)}
            getRowId={(l) => l.itemId}
            emptyMessage={t("nothingLeft")}
            renderCard={(l) => (
              <div className="flex justify-between gap-3 text-sm tabular-nums">
                <span className="font-medium">{label(l)}</span>
                <span>{l.remainingValue === null ? pcs(l.remaining ?? 0) : t("amountPieces", { amount: money(l.remainingValue), pieces: pcs(l.remaining ?? 0) })}</span>
              </div>
            )}
          />
          {totalLine(t("amountPieces", { amount: money(totals.remainingValue), pieces: pcs(totals.remaining) }))}
        </>
      ),
    },
    damaged: {
      title: t("damagedOrMissing"),
      help: t("damagedHelp"),
      body: (
        <>
          <DataTable
            columns={lineColumns([
              { id: "received", header: t("receivedHeader"), cell: ({ row }) => `${row.original.received ?? 0} / ${row.original.purchased}`, meta: { ...num, hideBelow: "md" } },
              { id: "damaged", header: t("damagedHeader"), cell: ({ row }) => row.original.damaged ?? 0, meta: num },
              { id: "missing", header: t("missingHeader"), cell: ({ row }) => row.original.missing ?? 0, meta: num },
              { id: "value", header: t("valueHeader"), cell: ({ row }) => (row.original.damagedValue === null ? "—" : money(row.original.damagedValue)), meta: num },
              { id: "reason", header: t("reasonHeader"), cell: ({ row }) => <span className="block min-w-40">{row.original.receiveReason ?? "—"}</span> },
            ])}
            data={report.lines.filter((l) => (l.damagedOrMissing ?? 0) > 0)}
            getRowId={(l) => l.itemId}
            emptyMessage={t("nothingDamaged")}
            renderCard={(l) => (
              <div className="flex flex-col gap-1 text-sm">
                <span className="flex justify-between gap-3">
                  <span className="font-medium">{label(l)}</span>
                  <span className="tabular-nums font-medium">{l.damagedValue === null ? "—" : money(l.damagedValue)}</span>
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("damagedHeader")} {l.damaged ?? 0} · {t("missingHeader")} {l.missing ?? 0}
                </span>
                {l.receiveReason ? <span className="text-xs">{l.receiveReason}</span> : null}
              </div>
            )}
          />
          {totalLine(t("amountPieces", { amount: money(totals.damagedValue), pieces: pcs(totals.damagedOrMissing) }))}
        </>
      ),
    },
    differences: {
      title: t("differences"),
      help: t("differencesHelp"),
      body: (
        <>
          {hiddenNote}
          {report.saleLinesHidden ? null : (
            <DataTable
              columns={differenceColumns}
              data={differing}
              getRowId={(l) => l.saleItemId}
              emptyMessage={t("noDifferences")}
              renderCard={(l) =>
                saleCard(
                  l,
                  <>
                    <span className="text-xs tabular-nums">
                      {t("todayPriceHeader")} {l.todayPrice === null ? "—" : money(l.todayPrice)}
                      {l.priceAtSale !== null && l.priceAtSale !== l.todayPrice ? ` · ${t("priceAtSaleHeader")} ${money(l.priceAtSale)}` : ""}
                    </span>
                    <span className="font-medium tabular-nums">{signed(l.difference ?? 0)}</span>
                    <span className="text-xs">{reason(l)}</span>
                  </>,
                )
              }
            />
          )}
          {totalLine(signed(totals.priceDifference))}
        </>
      ),
    },
  };

  const columns: DataTableColumn<Line>[] = [
    {
      id: "product",
      header: t("productHeader"),
      cell: ({ row }) => (
        <span className="block min-w-40">
          <span className="block font-medium">{label(row.original)}</span>
          <span className="block text-xs text-muted-foreground">{row.original.sku}</span>
        </span>
      ),
    },
    { id: "purchased", header: t("purchasedHeader"), cell: ({ row }) => row.original.purchased, meta: { align: "right", className: "tabular-nums" } },
    {
      id: "price",
      header: t("priceHeader"),
      cell: ({ row }) => (row.original.price === null ? "—" : money(row.original.price)),
      meta: { align: "right", hideBelow: "lg", className: "tabular-nums whitespace-nowrap" },
    },
    {
      id: "expected",
      header: t("expectedHeader"),
      cell: ({ row }) => (row.original.expected === null ? "—" : money(row.original.expected)),
      meta: { align: "right", className: "tabular-nums whitespace-nowrap font-medium" },
    },
    {
      id: "sold",
      header: t("soldHeader"),
      cell: ({ row }) =>
        row.original.sold === null ? notReceived : t("amountPieces", { amount: money(row.original.sold.amount), pieces: pcs(row.original.sold.qty) }),
      meta: { align: "right", hideBelow: "sm", className: "tabular-nums whitespace-nowrap" },
    },
    {
      id: "remaining",
      header: t("remainingHeader"),
      cell: ({ row }) =>
        row.original.remaining === null
          ? notReceived
          : row.original.remainingValue === null
            ? pcs(row.original.remaining)
            : t("amountPieces", { amount: money(row.original.remainingValue), pieces: pcs(row.original.remaining) }),
      meta: { align: "right", hideBelow: "md", className: "tabular-nums whitespace-nowrap" },
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-heading text-lg font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatButton label={t("expected")} details={t("details")} onClick={() => setOpen("expected")}>
          <span className="text-lg font-semibold tabular-nums">{money(totals.expected)}</span>
          <span className="text-xs text-muted-foreground">{pcs(totals.purchased)}</span>
        </StatButton>
        {report.received ? (
          <>
            <StatButton label={t("sold")} details={t("details")} onClick={() => setOpen("sold")}>
              <span className="text-lg font-semibold tabular-nums">{money(totals.soldAmount)}</span>
              <span className="text-xs text-muted-foreground">{pcs(totals.soldQty)}</span>
            </StatButton>
            <StatButton label={t("remaining")} details={t("details")} onClick={() => setOpen("remaining")}>
              <span className="text-lg font-semibold tabular-nums">{money(totals.remainingValue)}</span>
              <span className="text-xs text-muted-foreground">{pcs(totals.remaining)}</span>
            </StatButton>
            <StatButton label={t("damagedOrMissing")} details={t("details")} onClick={() => setOpen("damaged")}>
              <span className="text-lg font-semibold tabular-nums">{money(totals.damagedValue)}</span>
              <span className="text-xs text-muted-foreground">{pcs(totals.damagedOrMissing)}</span>
            </StatButton>
            <StatButton label={t("differences")} details={t("details")} onClick={() => setOpen("differences")}>
              <span className="text-lg font-semibold tabular-nums">{money(Math.abs(totals.priceDifference))}</span>
              <span className="text-xs text-muted-foreground">
                {totals.priceDifference === 0 ? t("noDifferenceShort") : t(totals.priceDifference > 0 ? "belowShort" : "aboveShort")}
                {report.saleLinesHidden ? "" : ` · ${t("saleLines", { count: differing.length })}`}
              </span>
            </StatButton>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("sold")}</p>
              <p className="text-sm">{notReceived}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("remaining")}</p>
              <p className="text-sm">{notReceived}</p>
            </div>
          </>
        )}
      </div>

      {report.unpriced.length > 0 ? (
        <p role="note" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
          {t("unpriced", { count: report.unpriced.length, names: report.unpriced.map(label).join(", ") })}
          {canSetPrice ? (
            <>
              {" "}
              <Link href={`/${service}/products/prices`} className="font-medium underline underline-offset-4">
                {t("setPrices")}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <DataTable
        columns={columns}
        data={report.lines}
        getRowId={(l) => l.itemId}
        pagination={false}
        renderCard={(l) => (
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{label(l)}</span>
            <span className="text-xs text-muted-foreground">
              {[l.sku, pcs(l.purchased), l.price === null ? null : money(l.price)].filter(Boolean).join(" · ")}
            </span>
            <span className="flex flex-wrap justify-between gap-x-3 tabular-nums">
              <span>
                {t("expectedHeader")}: {l.expected === null ? "—" : money(l.expected)}
              </span>
              <span>
                {t("soldHeader")}:{" "}
                {l.sold === null ? notReceived : t("amountPieces", { amount: money(l.sold.amount), pieces: pcs(l.sold.qty) })}
              </span>
              <span>
                {t("remainingHeader")}:{" "}
                {l.remaining === null
                  ? notReceived
                  : l.remainingValue === null
                    ? pcs(l.remaining)
                    : t("amountPieces", { amount: money(l.remainingValue), pieces: pcs(l.remaining) })}
              </span>
            </span>
          </div>
        )}
      />
      <p className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-sm tabular-nums">
        <span className="font-medium">{t("total")}</span>
        <span>
          {t("expectedHeader")} {money(totals.expected)}
        </span>
        {report.received ? (
          <>
            <span>
              {t("soldHeader")} {t("amountPieces", { amount: money(totals.soldAmount), pieces: pcs(totals.soldQty) })}
            </span>
            <span>
              {t("remainingHeader")} {t("amountPieces", { amount: money(totals.remainingValue), pieces: pcs(totals.remaining) })}
            </span>
            <span>
              {t("damagedOrMissing")} {t("amountPieces", { amount: money(totals.damagedValue), pieces: pcs(totals.damagedOrMissing) })}
            </span>
            <span>
              {t("differences")} {signed(totals.priceDifference)}
            </span>
          </>
        ) : null}
      </p>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        {open ? (
          <DialogContent className="flex max-h-[90vh] flex-col gap-3 overflow-y-auto sm:max-w-4xl">
            <DialogHeader className="pr-8">
              <DialogTitle className="font-heading text-lg font-semibold">
                {details[open].title} · {report.number}
              </DialogTitle>
              <DialogDescription>{details[open].help}</DialogDescription>
            </DialogHeader>
            {details[open].body}
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}
