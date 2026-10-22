"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useQuery, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import type { ContractPaymentStatus } from "../../../convex/lib/transport";
import { Link, useRouter } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { DateRangeFilter, useDateRangeLabel } from "@/components/filters/date-range-filter";
import { FilterField } from "@/components/filters/filter-field";
import { FilterPanel, type FilterChip } from "@/components/filters/filter-panel";
import { ContractDates, PaymentBadge } from "@/components/fleet/contract-bits";
import { buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useCan } from "@/lib/use-can";

type ContractRow = PaginatedQueryItem<typeof api.contracts.list>;
type Filters = { from: string; to: string; carId: string; clientId: string; paymentStatus: ContractPaymentStatus | "" };
const NO_FILTERS: Filters = { from: "", to: "", carId: "", clientId: "", paymentStatus: "" };

/** Contracts, latest start first, with filters (dates, car, client, payment) and "New contract". */
export function ContractsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Contracts");
  const locale = useLocale();
  const router = useRouter();
  const canView = useCan("transport.view");
  const canManage = useCan("transport.contracts.manage");
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const dateLabel = useDateRangeLabel();
  const cars = useQuery(api.cars.list, canView ? { businessUnitKey: service } : "skip");
  const clients = useQuery(api.clients.list, canView ? { businessUnitKey: service } : "skip");
  const { results, pagination } = useCursorPaginatedQuery(
    api.contracts.list,
    canView
      ? {
          businessUnitKey: service,
          ...(applied.from ? { from: applied.from } : {}),
          ...(applied.to ? { to: applied.to } : {}),
          ...(applied.carId ? { carId: applied.carId as Id<"cars"> } : {}),
          ...(applied.clientId ? { clientId: applied.clientId as Id<"clients"> } : {}),
          ...(applied.paymentStatus ? { paymentStatus: applied.paymentStatus } : {}),
        }
      : "skip",
  );

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const href = (c: ContractRow) => `/${service}/contracts/${c._id}`;

  const chips = (f: Filters): FilterChip<Filters>[] => {
    const list: FilterChip<Filters>[] = [];
    const dates = dateLabel(f);
    if (dates) list.push({ id: "dates", label: dates, clear: (v) => ({ ...v, from: "", to: "" }) });
    const car = cars?.find((c) => c._id === f.carId);
    if (car) list.push({ id: "car", label: car.plateNumber, clear: (v) => ({ ...v, carId: "" }) });
    const client = clients?.find((c) => c._id === f.clientId);
    if (client) list.push({ id: "client", label: client.name, clear: (v) => ({ ...v, clientId: "" }) });
    if (f.paymentStatus) {
      list.push({ id: "payment", label: t(`paymentStatus.${f.paymentStatus}`), clear: (v) => ({ ...v, paymentStatus: "" }) });
    }
    return list;
  };

  const columns: DataTableColumn<ContractRow>[] = [
    {
      id: "number",
      header: t("numberHeader"),
      cell: ({ row }) => (
        <Link href={href(row.original)} className="font-mono text-xs font-medium underline-offset-4 hover:underline">
          {row.original.number}
        </Link>
      ),
      meta: { className: "whitespace-nowrap" },
    },
    { id: "car", header: t("carHeader"), cell: ({ row }) => <span className="font-mono">{row.original.plateNumber}</span>, meta: { className: "whitespace-nowrap" } },
    { id: "client", header: t("clientHeader"), cell: ({ row }) => row.original.clientName, meta: { hideBelow: "md" } },
    { id: "dates", header: t("datesHeader"), cell: ({ row }) => <ContractDates contract={row.original} />, meta: { hideBelow: "sm" } },
    {
      id: "total",
      header: t("totalHeader"),
      cell: ({ row }) => money(row.original.totalAmount),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
    { id: "payment", header: t("paymentHeader"), cell: ({ row }) => <PaymentBadge contract={row.original} />, meta: { hideBelow: "md" } },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canManage ? (
          <Link href={`/${service}/contracts/new`} className={buttonVariants({ size: "lg", className: "min-h-11" })}>
            <Plus aria-hidden />
            {t("new")}
          </Link>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(c) => c._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        toolbar={
          <FilterPanel value={applied} onApply={setApplied} emptyValue={NO_FILTERS} chips={chips}>
            {(draft, setDraft) => (
              <>
                <DateRangeFilter id="contracts-dates" value={draft} onChange={(r) => setDraft({ ...draft, from: r.from, to: r.to })} />
                <FilterField id="contracts-car" label={t("carHeader")}>
                  <NativeSelect id="contracts-car" value={draft.carId} onChange={(e) => setDraft({ ...draft, carId: e.target.value })} className="h-11 w-full sm:h-8">
                    <option value="">{t("allCars")}</option>
                    {(cars ?? []).map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.plateNumber}
                      </option>
                    ))}
                  </NativeSelect>
                </FilterField>
                <FilterField id="contracts-client" label={t("clientHeader")}>
                  <NativeSelect id="contracts-client" value={draft.clientId} onChange={(e) => setDraft({ ...draft, clientId: e.target.value })} className="h-11 w-full sm:h-8">
                    <option value="">{t("allClients")}</option>
                    {(clients ?? []).map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </FilterField>
                <FilterField id="contracts-payment" label={t("paymentHeader")}>
                  <NativeSelect
                    id="contracts-payment"
                    value={draft.paymentStatus}
                    onChange={(e) => setDraft({ ...draft, paymentStatus: e.target.value as ContractPaymentStatus | "" })}
                    className="h-11 w-full sm:h-8"
                  >
                    <option value="">{t("paymentStatus.all")}</option>
                    <option value="open">{t("paymentStatus.open")}</option>
                    <option value="settled">{t("paymentStatus.settled")}</option>
                  </NativeSelect>
                </FilterField>
              </>
            )}
          </FilterPanel>
        }
        renderCard={(c) => (
          <button type="button" onClick={() => router.push(href(c))} className="flex w-full flex-col gap-1.5 text-left">
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-medium">{c.number}</span>
              <span className="font-semibold tabular-nums">{money(c.totalAmount)}</span>
            </span>
            <span className="text-sm">
              <span className="font-mono">{c.plateNumber}</span> · {c.clientName}
            </span>
            <span className="text-xs text-muted-foreground">
              <ContractDates contract={c} />
            </span>
            <PaymentBadge contract={c} />
          </button>
        )}
      />
      <p className="text-xs text-muted-foreground">{t("timeZoneNote")}</p>
    </div>
  );
}
