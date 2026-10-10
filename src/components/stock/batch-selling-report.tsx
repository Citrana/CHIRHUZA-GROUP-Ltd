"use client";

import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import type { api } from "../../../convex/_generated/api";
import { formatMoney } from "../../../convex/lib/money";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCan } from "@/lib/use-can";

export type SellingReport = NonNullable<FunctionReturnType<typeof api.stockBatches.sellingReport>>;
type Line = SellingReport["lines"][number];

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
  const label = (p: { name: string | null; lengthInches: number | null; sizeName: string | null; colourName: string | null }) =>
    [p.name ?? "—", p.lengthInches !== null ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
      .filter(Boolean)
      .join(" · ");
  const notReceived = <span className="text-muted-foreground">{t("notReceived")}</span>;
  const { totals } = report;

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("expected")}</p>
          <p className="text-lg font-semibold tabular-nums">{money(totals.expected)}</p>
          <p className="text-xs text-muted-foreground">{pcs(totals.purchased)}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("sold")}</p>
          {report.received ? (
            <>
              <p className="text-lg font-semibold tabular-nums">{money(totals.soldAmount)}</p>
              <p className="text-xs text-muted-foreground">{pcs(totals.soldQty)}</p>
            </>
          ) : (
            <p className="text-sm">{notReceived}</p>
          )}
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("remaining")}</p>
          {report.received ? (
            <>
              <p className="text-lg font-semibold tabular-nums">{money(totals.remainingValue)}</p>
              <p className="text-xs text-muted-foreground">{pcs(totals.remaining)}</p>
            </>
          ) : (
            <p className="text-sm">{notReceived}</p>
          )}
        </div>
        {report.received ? (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{t("damagedOrMissing")}</p>
            <p className="text-lg font-semibold tabular-nums">{pcs(totals.damagedOrMissing)}</p>
          </div>
        ) : null}
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
          </>
        ) : null}
      </p>
    </section>
  );
}
