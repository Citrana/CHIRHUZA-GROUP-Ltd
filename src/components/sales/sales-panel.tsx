"use client";

import { useState } from "react";
import { HandCoins, Plus } from "lucide-react";
import { useQuery, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type SaleRow = PaginatedQueryItem<typeof api.sales.list>;

/** "Recorded 30 Sep" on a sale entered on a later day than it happened. */
function RecordedBadge({ sale }: { sale: SaleRow }) {
  const t = useTranslations("Sales");
  const locale = useLocale();
  if (!sale.backdated || !sale.recordedAt) return null;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: BUSINESS_TIME_ZONE });
  return <Badge variant="outline">{t("recordedBadge", { date: day.format(sale.recordedAt) })}</Badge>;
}

/** "Owes $30.00" / "Paid" on a credit sale. */
function CreditBadge({ sale }: { sale: SaleRow }) {
  const t = useTranslations("Sales");
  const locale = useLocale();
  if (sale.balance === null) return null;
  return sale.balance > 0 ? (
    <Badge variant="destructive">{t("creditBalance", { amount: formatMoney(sale.balance, "USD", locale) })}</Badge>
  ) : (
    <Badge variant="secondary">{t("creditPaid")}</Badge>
  );
}

/** Sales list (sales.view) with date and location filters; "New sale" for sellers. */
export function SalesPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Sales");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canView = useCan("sales.view");
  const canSell = useCan("sales.create");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [locationId, setLocationId] = useState("");
  const filters = useQuery(api.sales.filterLocations, canView ? { businessUnitKey: service } : "skip");
  const { results, pagination } = useCursorPaginatedQuery(
    api.sales.list,
    canView
      ? {
          businessUnitKey: service,
          ...(locationId ? { locationId: locationId as Id<"locations"> } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        }
      : "skip",
  );

  if (canView === undefined) return null;
  if (!canView) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>
        {canSell ? (
          <Link href={`/${service}/sales/new`} className={buttonVariants({ size: "lg", className: "min-h-11 self-start" })}>
            <Plus aria-hidden />
            {t("new")}
          </Link>
        ) : null}
      </div>
    );
  }

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const marginClass = (cents: number) => cn("tabular-nums", cents < 0 && "text-destructive");

  const columns: DataTableColumn<SaleRow>[] = [
    {
      id: "number",
      header: t("numberHeader"),
      cell: ({ row }) => row.original.number,
      meta: { className: "whitespace-nowrap font-mono text-xs font-medium" },
    },
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          {time.format(row.original.createdAt)}
          <RecordedBadge sale={row.original} />
        </span>
      ),
      meta: { className: "whitespace-nowrap text-muted-foreground" },
    },
    { id: "location", header: t("locationHeader"), cell: ({ row }) => row.original.locationName ?? "—", meta: { hideBelow: "md" } },
    {
      id: "seller",
      header: t("sellerHeader"),
      cell: ({ row }) => row.original.soldByName ?? "—",
      meta: { hideBelow: "lg", className: "text-muted-foreground" },
    },
    {
      id: "payment",
      header: t("paymentHeader"),
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          {t(`payments.${row.original.paymentMethod}`)}
          <CreditBadge sale={row.original} />
        </span>
      ),
      meta: { hideBelow: "md" },
    },
    {
      id: "total",
      header: t("totalHeader"),
      cell: ({ row }) => money(row.original.totalAmount),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
    {
      id: "margin",
      header: t("marginHeader"),
      cell: ({ row }) => <span className={marginClass(row.original.margin)}>{money(row.original.margin)}</span>,
      meta: { hideBelow: "sm", className: "whitespace-nowrap" },
    },
  ];

  const details = (sale: SaleRow) => (
    <div className="flex flex-col gap-3 text-sm">
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
        {sale.lines.map((line) => (
          <li key={line._id} className="flex flex-col gap-1 px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-medium">
                  {[
                    line.productName ?? "—",
                    line.lengthInches !== null ? tProducts("inches", { inches: line.lengthInches }) : null, line.sizeName,
                    line.colourName,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
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
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/${service}/sales/credit`} className={buttonVariants({ variant: "outline", size: "lg", className: "min-h-11" })}>
            <HandCoins aria-hidden />
            {t("creditLink")}
          </Link>
          {canSell ? (
            <Link href={`/${service}/sales/new`} className={buttonVariants({ size: "lg", className: "min-h-11" })}>
              <Plus aria-hidden />
              {t("new")}
            </Link>
          ) : null}
        </div>
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(sale) => sale._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        renderExpanded={details}
        toolbar={
          <div className="flex w-full flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="sales-from" className="text-xs text-muted-foreground">
                {t("fromLabel")}
              </Label>
              <Input id="sales-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40 sm:h-8" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sales-to" className="text-xs text-muted-foreground">
                {t("toLabel")}
              </Label>
              <Input id="sales-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-10 w-40 sm:h-8" />
            </div>
            {filters && !filters.locked ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="sales-location" className="text-xs text-muted-foreground">
                  {t("locationHeader")}
                </Label>
                <NativeSelect id="sales-location" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-10 w-48 sm:h-8">
                  <option value="">{t("allLocations")}</option>
                  {filters.locations.map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {from || to || locationId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-10 sm:h-8"
                onClick={() => {
                  setFrom("");
                  setTo("");
                  setLocationId("");
                }}
              >
                {t("resetFilters")}
              </Button>
            ) : null}
          </div>
        }
        renderCard={(sale) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium">{sale.number}</span>
                <RecordedBadge sale={sale} />
              </span>
              <span className="font-semibold tabular-nums">{money(sale.totalAmount)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {[sale.locationName, t(`payments.${sale.paymentMethod}`), time.format(sale.createdAt)].filter(Boolean).join(" · ")}
            </p>
            <p className="text-xs">
              {t("pieces", { count: sale.totalQty })} · {t("marginHeader")}{" "}
              <span className={marginClass(sale.margin)}>{money(sale.margin)}</span>
            </p>
            <CreditBadge sale={sale} />
          </div>
        )}
      />
      <p className="text-xs text-muted-foreground">{t("timeZoneNote")}</p>
    </div>
  );
}
