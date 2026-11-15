"use client";

import { ArrowLeftRight, PencilLine } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { useProductLineLabel } from "./use-product-line-label";

export type SaleRow = PaginatedQueryItem<typeof api.sales.list>;

/** "Recorded 30 Sep" on a sale entered on a later day than it happened. */
export function RecordedBadge({ sale }: { sale: SaleRow }) {
  const t = useTranslations("Sales");
  const locale = useLocale();
  if (!sale.backdated || !sale.recordedAt) return null;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
  return <Badge variant="outline">{t("recordedBadge", { date: day.format(sale.recordedAt) })}</Badge>;
}

/** "Exchanged" once products of the sale were swapped; "Exchange waiting" for a refund to approve. */
export function ExchangeBadge({ sale }: { sale: SaleRow }) {
  const t = useTranslations("SaleExchange");
  if (sale.pendingExchange) return <Badge variant="outline">{t("pendingBadge")}</Badge>;
  if (sale.exchanges.length === 0) return null;
  return <Badge variant="secondary">{t("exchangedBadge")}</Badge>;
}

/** "Owes $30.00" / "Paid" on a credit sale; "Cancelled - mistake" on a voided sale. */
export function CreditBadge({ sale }: { sale: SaleRow }) {
  const t = useTranslations("Sales");
  const locale = useLocale();
  if (sale.status === "voided") return <Badge variant="outline">{t("voided")}</Badge>;
  if (sale.balance === null) return null;
  return sale.balance > 0 ? (
    <Badge variant="destructive">{t("creditBalance", { amount: formatMoney(sale.balance, "USD", locale) })}</Badge>
  ) : (
    <Badge variant="secondary">{t("creditPaid")}</Badge>
  );
}

/**
 * One sale of sales.list in full: lines with cost and margin, who / where /
 * how, discounts, credit payments and exchanges, and the "Request
 * correction" (date, quantities, prices... - SaleEditDialog, opened by the
 * caller through `onRequestEdit`) and Exchange actions. Shared by the sales
 * list and Check sales.
 */
export function SaleDetails({
  sale,
  service,
  onRequestEdit,
}: {
  sale: SaleRow;
  service: BusinessUnitKey;
  onRequestEdit: (saleId: Id<"sales">) => void;
}) {
  const t = useTranslations("Sales");
  const tExchange = useTranslations("SaleExchange");
  const lineLabel = useProductLineLabel();
  const locale = useLocale();
  const canSell = useCan("sales.create");
  const canRequestEdit = useCan("sales.edit.request");
  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const marginClass = (cents: number) => cn("tabular-nums", cents < 0 && "text-destructive");
  return (
  <div className="flex flex-col gap-3 text-sm">
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
      {sale.lines.map((line) => (
        <li key={line._id} className="flex flex-col gap-1 px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block font-medium">
                {lineLabel(line)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {[line.sku, line.batchNumber].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block font-medium">{t("qtyAtPrice", { qty: line.qty, price: money(line.unitPrice) })}</span>
              <span className="block text-xs text-muted-foreground">
                {t("costAndMargin", { cost: money(line.unitCostSnapshot) })}{" "}
                <span className={marginClass(line.margin)}>{money(line.margin)}</span>
              </span>
            </span>
          </div>
          {line.discountReason ? (
            <p className="text-xs text-muted-foreground">{t("discountReasonShown", { reason: line.discountReason })}</p>
          ) : null}
        </li>
      ))}
    </ul>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
      {sale.backdated && sale.recordedAt ? (
        <>
          <dt>{t("recordedAtLabel")}</dt>
          <dd className="text-foreground">{time.format(sale.recordedAt)}</dd>
        </>
      ) : null}
      <dt>{t("locationHeader")}</dt>
      <dd className="text-foreground">{sale.locationName ?? "—"}</dd>
      <dt>{t("sellerHeader")}</dt>
      <dd className="text-foreground">{sale.soldByName ?? "—"}</dd>
      <dt>{t("paymentHeader")}</dt>
      <dd className="text-foreground">{t(`payments.${sale.paymentMethod}`)}</dd>
      {sale.customerName ? (
        <>
          <dt>{t("customerLabel")}</dt>
          <dd className="text-foreground">{sale.customerName}</dd>
        </>
      ) : null}
    </dl>
    {sale.status === "voided" ? (
      <p className="text-xs text-muted-foreground">{t("voidedShown", { reason: sale.voidReason ?? "—" })}</p>
    ) : null}
    {sale.saleDiscountReason && sale.linesTotal !== undefined ? (
      <p className="text-xs text-muted-foreground">
        {t("saleDiscountShown", { lines: money(sale.linesTotal), reason: sale.saleDiscountReason })}
      </p>
    ) : null}
    {sale.balance !== null ? (
      <div className="flex flex-col gap-1">
        <p className="flex items-center justify-between gap-2 font-medium">
          {t("paymentsTitle")}
          <CreditBadge sale={sale} />
        </p>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
          {sale.payments.map((p) => (
            <li key={p._id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-muted-foreground">
                {[t(`paymentKinds.${p.kind}`), t(`payments.${p.method}`), time.format(p.paidAt)].join(" · ")}
              </span>
              <span className={cn("shrink-0 tabular-nums", p.amount < 0 && "text-destructive")}>{money(p.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    {sale.exchanges.length > 0 ? (
      <div className="flex flex-col gap-1">
        <p className="font-medium">{tExchange("historyTitle")}</p>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
          {sale.exchanges.map((exchange) => (
            <li key={exchange._id} className="flex flex-col gap-1 px-3 py-2">
              <p className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-medium">{exchange.number}</span>
                <span className="text-xs text-muted-foreground">
                  {[time.format(exchange.createdAt), exchange.recordedByName].filter(Boolean).join(" · ")}
                </span>
              </p>
              {exchange.items.map((item) => (
                <p key={item._id} className="flex justify-between gap-3 text-xs">
                  <span className="min-w-0">
                    <span className="text-muted-foreground">
                      {item.direction === "returned" ? tExchange("returnedShort") : tExchange("givenShort")}
                    </span>{" "}
                    {lineLabel(item)}
                  </span>
                  <span className="shrink-0 tabular-nums">{t("qtyAtPrice", { qty: item.qty, price: money(item.unitPrice) })}</span>
                </p>
              ))}
              <p className="flex justify-between gap-3 text-xs font-medium">
                <span>
                  {exchange.differenceAmount > 0
                    ? tExchange("customerPaid")
                    : exchange.differenceAmount < 0
                      ? tExchange("givenBack")
                      : tExchange("even")}
                  {exchange.settlementMethod ? ` · ${t(`payments.${exchange.settlementMethod}`)}` : null}
                </span>
                <span className={cn("tabular-nums", exchange.differenceAmount < 0 && "text-destructive")}>
                  {money(Math.abs(exchange.differenceAmount))}
                </span>
              </p>
              {exchange.reason ? (
                <p className="text-xs text-muted-foreground">{tExchange("reasonShown", { reason: exchange.reason })}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    {sale.pendingExchange ? <p className="text-muted-foreground">{tExchange("pendingExchange")}</p> : null}
    <div className="flex flex-wrap gap-2">
      {canRequestEdit && sale.status === "completed" && sale.exchanges.length === 0 && !sale.pendingExchange ? (
        sale.pendingEdit ? (
          <p className="text-muted-foreground">{t("editPending")}</p>
        ) : (
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onRequestEdit(sale._id)}>
            <PencilLine aria-hidden />
            {t("editRequest")}
          </Button>
        )
      ) : null}
      {canSell && sale.exchangeable ? (
        <Link
          href={`/${service}/sales/${sale._id}/exchange`}
          className={buttonVariants({ variant: "outline", className: "min-h-11" })}
        >
          <ArrowLeftRight aria-hidden />
          {tExchange("action")}
        </Link>
      ) : null}
    </div>
  </div>
  );
}
