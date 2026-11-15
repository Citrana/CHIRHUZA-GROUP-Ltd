"use client";

import { useState } from "react";
import { HandCoins, Plus, SearchCheck } from "lucide-react";
import { useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import type { CreditStatus } from "../../../convex/lib/credit";
import { formatMoney } from "../../../convex/lib/money";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { DateRangeFilter, useDateRangeLabel } from "@/components/filters/date-range-filter";
import { FilterField } from "@/components/filters/filter-field";
import { FilterPanel, type FilterChip } from "@/components/filters/filter-panel";
import { buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { SaleEditDialog } from "./sale-edit-dialog";
import { CreditBadge, ExchangeBadge, RecordedBadge, SaleDetails, type SaleRow } from "./sale-details";

type SalesFilters = { from: string; to: string; locationId: string; creditStatus: CreditStatus | "" };
const NO_FILTERS: SalesFilters = { from: "", to: "", locationId: "", creditStatus: "" };

/**
 * Sales list (sales.view) with date (shortcuts or a range), location and
 * credit-status filters in a FilterPanel; "New sale" for sellers.
 */
export function SalesPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Sales");
  const locale = useLocale();
  const canView = useCan("sales.view");
  const canSell = useCan("sales.create");
  const [editing, setEditing] = useState<Id<"sales"> | null>(null);
  const [applied, setApplied] = useState<SalesFilters>(NO_FILTERS);
  const { from, to, locationId, creditStatus } = applied;
  const dateLabel = useDateRangeLabel();
  const filters = useQuery(api.sales.filterLocations, canView ? { businessUnitKey: service } : "skip");
  const { results, pagination } = useCursorPaginatedQuery(
    api.sales.list,
    canView
      ? {
          businessUnitKey: service,
          ...(locationId ? { locationId: locationId as Id<"locations"> } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(creditStatus ? { creditStatus } : {}),
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

  // Active filters, as chips. The location is no filter for viewers locked to theirs.
  const chips = (f: SalesFilters): FilterChip<SalesFilters>[] => {
    const list: FilterChip<SalesFilters>[] = [];
    const dates = dateLabel(f);
    if (dates) list.push({ id: "dates", label: dates, clear: (v) => ({ ...v, from: "", to: "" }) });
    const location = f.locationId && filters && !filters.locked ? filters.locations.find((l) => l._id === f.locationId) : undefined;
    if (location) list.push({ id: "location", label: location.name, clear: (v) => ({ ...v, locationId: "" }) });
    if (f.creditStatus) {
      list.push({ id: "credit", label: t(`creditStatus.${f.creditStatus}`), clear: (v) => ({ ...v, creditStatus: "" }) });
    }
    return list;
  };

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
          <ExchangeBadge sale={row.original} />
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

  const details = (sale: SaleRow) => <SaleDetails sale={sale} service={service} onRequestEdit={setEditing} />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/${service}/sales/check`} className={buttonVariants({ variant: "outline", size: "lg", className: "min-h-11" })}>
            <SearchCheck aria-hidden />
            {t("checkLink")}
          </Link>
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
          <FilterPanel value={applied} onApply={setApplied} emptyValue={NO_FILTERS} chips={chips}>
            {(draft, setDraft) => (
              <>
                <DateRangeFilter
                  id="sales-dates"
                  value={draft}
                  onChange={(range) => setDraft({ ...draft, from: range.from, to: range.to })}
                />
                {filters && !filters.locked ? (
                  <FilterField id="sales-location" label={t("locationHeader")}>
                    <NativeSelect
                      id="sales-location"
                      value={draft.locationId}
                      onChange={(e) => setDraft({ ...draft, locationId: e.target.value })}
                      className="h-11 w-full sm:h-8"
                    >
                      <option value="">{t("allLocations")}</option>
                      {filters.locations.map((l) => (
                        <option key={l._id} value={l._id}>
                          {l.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </FilterField>
                ) : null}
                <FilterField id="sales-credit" label={t("creditStatusLabel")}>
                  <NativeSelect
                    id="sales-credit"
                    value={draft.creditStatus}
                    onChange={(e) => setDraft({ ...draft, creditStatus: e.target.value as CreditStatus | "" })}
                    className="h-11 w-full sm:h-8"
                  >
                    <option value="">{t("creditStatus.all")}</option>
                    <option value="open">{t("creditStatus.open")}</option>
                    <option value="settled">{t("creditStatus.settled")}</option>
                  </NativeSelect>
                </FilterField>
              </>
            )}
          </FilterPanel>
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
            <span className="flex flex-wrap gap-1">
              <CreditBadge sale={sale} />
              <ExchangeBadge sale={sale} />
            </span>
          </div>
        )}
      />
      <p className="text-xs text-muted-foreground">{t("timeZoneNote")}</p>
      <SaleEditDialog saleId={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
