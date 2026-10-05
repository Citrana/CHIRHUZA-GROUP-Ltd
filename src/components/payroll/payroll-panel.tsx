"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useQuery, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { PAYROLL_STATUSES, type PayrollStatus } from "../../../convex/lib/payroll";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { NewPayrollDialog } from "@/components/payroll/new-payroll-dialog";
import { useCan } from "@/lib/use-can";

type EntryRow = PaginatedQueryItem<typeof api.payroll.list>;

/** "2026-09" -> "September 2026" in the viewer's language. */
function useMonthLabel() {
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  return (period: string) => {
    const [y, m] = period.split("-").map(Number);
    return format.format(Date.UTC(y, m - 1, 15));
  };
}

/**
 * Payroll entries with period / location / status filters and totals, and
 * "New payroll entry". People who only submit see just their own entries.
 */
export function PayrollPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Payroll");
  const locale = useLocale();
  const monthLabel = useMonthLabel();
  const canView = useCan("payroll.view");
  const canCreate = useCan("payroll.create");
  const allowed = canView || canCreate;
  const [fromPeriod, setFromPeriod] = useState("");
  const [toPeriod, setToPeriod] = useState("");
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState<PayrollStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);
  const [thisMonth] = useState(() => businessDayOf(Date.now()).slice(0, 7));
  const filters = {
    businessUnitKey: service,
    ...(fromPeriod ? { fromPeriod } : {}),
    ...(toPeriod ? { toPeriod } : {}),
    ...(locationId ? { locationId: locationId as Id<"locations"> } : {}),
    ...(status ? { status } : {}),
  };
  const totals = useQuery(api.payroll.totals, allowed ? filters : "skip");
  const options = useQuery(api.payroll.options, canCreate ? { businessUnitKey: service } : "skip");
  const { results, pagination } = useCursorPaginatedQuery(api.payroll.list, allowed ? filters : "skip");

  if (canView === undefined) return null;
  if (!allowed) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });

  const columns: DataTableColumn<EntryRow>[] = [
    { id: "worker", header: t("workerHeader"), cell: ({ row }) => <span className="font-medium">{row.original.workerName}</span> },
    {
      id: "period",
      header: t("periodHeader"),
      cell: ({ row }) => monthLabel(row.original.period),
      meta: { className: "whitespace-nowrap" },
    },
    {
      id: "amount",
      header: t("amountHeader"),
      cell: ({ row }) => money(row.original.amount),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
    {
      id: "location",
      header: t("locationHeader"),
      cell: ({ row }) => row.original.locationName ?? t("noLocation"),
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => <ApprovalStatusBadge status={row.original.status} /> },
    {
      id: "by",
      header: t("submittedByHeader"),
      cell: ({ row }) => row.original.createdByName ?? "—",
      meta: { hideBelow: "lg", className: "text-muted-foreground" },
    },
  ];

  const details = (row: EntryRow) => (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <dt>{t("submittedByHeader")}</dt>
      <dd className="text-foreground">
        {row.createdByName ?? "—"} · {date.format(row.createdAt)}
      </dd>
      {row.note ? (
        <>
          <dt>{t("noteLabel")}</dt>
          <dd className="whitespace-pre-wrap text-foreground">{row.note}</dd>
        </>
      ) : null}
      {row.status === "pending" ? (
        <>
          <dt>{t("statusHeader")}</dt>
          <dd className="text-foreground">
            {t("pendingHint")}{" "}
            <Link href={`/${service}/approvals`} className="underline underline-offset-4">
              {t("viewApprovals")}
            </Link>
          </dd>
        </>
      ) : (
        <>
          <dt>{row.status === "approved" ? t("approvedBy") : t("rejectedBy")}</dt>
          <dd className="text-foreground">
            {row.decidedByName ?? "—"}
            {row.decidedAt ? ` · ${date.format(row.decidedAt)}` : null}
            {row.decisionNote ? <span className="block whitespace-pre-wrap">{row.decisionNote}</span> : null}
          </dd>
        </>
      )}
    </dl>
  );

  const filterLocations = canView && options && !options.locked ? options.locations : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{canView ? t("subtitle") : t("subtitleOwn")}</p>
        </div>
        {canCreate ? (
          <Button size="lg" className="min-h-11" onClick={() => setNewOpen(true)}>
            <Plus aria-hidden />
            {t("new")}
          </Button>
        ) : null}
      </div>

      <section className="grid grid-cols-2 gap-3 sm:max-w-md" aria-label={t("totalsLabel")}>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("approvedTotal")}</p>
          <p className="text-lg font-semibold tabular-nums">{totals ? money(totals.approved) : "—"}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{t("pendingTotal")}</p>
          <p className="text-lg font-semibold tabular-nums">{totals ? money(totals.pending) : "—"}</p>
        </div>
      </section>

      <DataTable
        columns={columns}
        data={results}
        getRowId={(e) => e._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        renderExpanded={details}
        toolbar={
          <div className="flex w-full flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="payroll-from" className="text-xs text-muted-foreground">
                {t("fromLabel")}
              </Label>
              <Input id="payroll-from" type="month" value={fromPeriod} max={toPeriod || undefined} onChange={(e) => setFromPeriod(e.target.value)} className="h-10 w-44 sm:h-8" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="payroll-to" className="text-xs text-muted-foreground">
                {t("toLabel")}
              </Label>
              <Input id="payroll-to" type="month" value={toPeriod} min={fromPeriod || undefined} onChange={(e) => setToPeriod(e.target.value)} className="h-10 w-44 sm:h-8" />
            </div>
            {filterLocations.length > 0 ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="payroll-location-filter" className="text-xs text-muted-foreground">
                  {t("locationHeader")}
                </Label>
                <NativeSelect id="payroll-location-filter" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-10 w-44 sm:h-8">
                  <option value="">{t("allLocations")}</option>
                  {filterLocations.map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <Label htmlFor="payroll-status" className="text-xs text-muted-foreground">
                {t("statusHeader")}
              </Label>
              <NativeSelect id="payroll-status" value={status} onChange={(e) => setStatus(e.target.value as PayrollStatus | "")} className="h-10 w-40 sm:h-8">
                <option value="">{t("allStatuses")}</option>
                {PAYROLL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`statuses.${s}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {fromPeriod || toPeriod || locationId || status ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-10 sm:h-8"
                onClick={() => {
                  setFromPeriod("");
                  setToPeriod("");
                  setLocationId("");
                  setStatus("");
                }}
              >
                {t("resetFilters")}
              </Button>
            ) : null}
          </div>
        }
        renderCard={(e) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{e.workerName}</span>
              <span className="font-semibold tabular-nums">{money(e.amount)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {monthLabel(e.period)} · {e.locationName ?? t("noLocation")}
              </p>
              <ApprovalStatusBadge status={e.status} />
            </div>
          </div>
        )}
      />
      {canCreate ? (
        <NewPayrollDialog service={service} defaultPeriod={thisMonth} open={newOpen} onOpenChange={setNewOpen} />
      ) : null}
    </div>
  );
}
