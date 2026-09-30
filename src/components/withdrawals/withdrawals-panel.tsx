"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useQuery, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { WITHDRAWAL_STATUSES, type WithdrawalStatus } from "../../../convex/lib/withdrawals";
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
import { NewWithdrawalDialog } from "@/components/withdrawals/new-withdrawal-dialog";
import { useCan } from "@/lib/use-can";

type WithdrawalRow = PaginatedQueryItem<typeof api.withdrawals.list>;

/**
 * Withdrawals with date / location / status filters and totals, and "New
 * withdrawal". Shown apart from business figures: never a business cost.
 */
export function WithdrawalsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Withdrawals");
  const locale = useLocale();
  const canView = useCan("withdrawals.view");
  const canRequest = useCan("withdrawals.request");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [locationId, setLocationId] = useState("");
  const [status, setStatus] = useState<WithdrawalStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);
  const [today] = useState(() => businessDayOf(Date.now()));
  const filters = {
    businessUnitKey: service,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(locationId ? { locationId: locationId as Id<"locations"> } : {}),
    ...(status ? { status } : {}),
  };
  const totals = useQuery(api.withdrawals.totals, canView ? filters : "skip");
  const options = useQuery(api.withdrawals.options, canRequest ? { businessUnitKey: service } : "skip");
  const { results, pagination } = useCursorPaginatedQuery(api.withdrawals.list, canView ? filters : "skip");

  if (canView === undefined) return null;
  if (!canView && !canRequest) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });

  const columns: DataTableColumn<WithdrawalRow>[] = [
    { id: "date", header: t("dateHeader"), cell: ({ row }) => day.format(row.original.date), meta: { className: "whitespace-nowrap" } },
    {
      id: "amount",
      header: t("amountHeader"),
      cell: ({ row }) => money(row.original.amount),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
    { id: "takenBy", header: t("takenByHeader"), cell: ({ row }) => row.original.takenByName ?? "—" },
    {
      id: "reason",
      header: t("reasonHeader"),
      cell: ({ row }) => row.original.reason,
      meta: { hideBelow: "md", className: "text-muted-foreground" },
    },
    {
      id: "location",
      header: t("locationHeader"),
      cell: ({ row }) => row.original.locationName ?? t("noLocation"),
      meta: { hideBelow: "lg", className: "text-muted-foreground" },
    },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => <ApprovalStatusBadge status={row.original.status} /> },
  ];

  const details = (row: WithdrawalRow) => (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <dt>{t("reasonHeader")}</dt>
      <dd className="whitespace-pre-wrap text-foreground">{row.reason}</dd>
      {row.note ? (
        <>
          <dt>{t("noteLabel")}</dt>
          <dd className="whitespace-pre-wrap text-foreground">{row.note}</dd>
        </>
      ) : null}
      <dt>{t("requestedBy")}</dt>
      <dd className="text-foreground">
        {row.requestedByName ?? "—"} · {time.format(row.createdAt)}
      </dd>
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
            {row.decidedAt ? ` · ${time.format(row.decidedAt)}` : null}
            {row.decisionNote ? <span className="block whitespace-pre-wrap">{row.decisionNote}</span> : null}
          </dd>
        </>
      )}
    </dl>
  );

  const filterLocations = options && !options.locked ? options.locations : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canRequest ? (
          <Button size="lg" className="min-h-11" onClick={() => setNewOpen(true)}>
            <Plus aria-hidden />
            {t("new")}
          </Button>
        ) : null}
      </div>

      {canView ? (
        <>
          <section className="flex flex-col gap-2" aria-label={t("totalsLabel")}>
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">{t("approvedTotal")}</p>
                <p className="text-lg font-semibold tabular-nums">{totals ? money(totals.approved) : "—"}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">{t("pendingTotal")}</p>
                <p className="text-lg font-semibold tabular-nums">{totals ? money(totals.pending) : "—"}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("notAnExpense")}</p>
          </section>

          <DataTable
            columns={columns}
            data={results}
            getRowId={(w) => w._id}
            emptyMessage={t("empty")}
            pagination={{ mode: "server", ...pagination }}
            renderExpanded={details}
            toolbar={
              <div className="flex w-full flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="withdrawals-from" className="text-xs text-muted-foreground">
                    {t("fromLabel")}
                  </Label>
                  <Input id="withdrawals-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="h-10 w-40 sm:h-8" />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="withdrawals-to" className="text-xs text-muted-foreground">
                    {t("toLabel")}
                  </Label>
                  <Input id="withdrawals-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-10 w-40 sm:h-8" />
                </div>
                {filterLocations.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="withdrawals-location" className="text-xs text-muted-foreground">
                      {t("locationHeader")}
                    </Label>
                    <NativeSelect id="withdrawals-location" value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-10 w-44 sm:h-8">
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
                  <Label htmlFor="withdrawals-status" className="text-xs text-muted-foreground">
                    {t("statusHeader")}
                  </Label>
                  <NativeSelect id="withdrawals-status" value={status} onChange={(e) => setStatus(e.target.value as WithdrawalStatus | "")} className="h-10 w-40 sm:h-8">
                    <option value="">{t("allStatuses")}</option>
                    {WITHDRAWAL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`statuses.${s}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {from || to || locationId || status ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-10 sm:h-8"
                    onClick={() => {
                      setFrom("");
                      setTo("");
                      setLocationId("");
                      setStatus("");
                    }}
                  >
                    {t("resetFilters")}
                  </Button>
                ) : null}
              </div>
            }
            renderCard={(w) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{w.takenByName ?? "—"}</span>
                  <span className="font-semibold tabular-nums">{money(w.amount)}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{w.reason}</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {day.format(w.date)} · {w.locationName ?? t("noLocation")}
                  </p>
                  <ApprovalStatusBadge status={w.status} />
                </div>
              </div>
            )}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("requestOnly")}</p>
      )}
      {canRequest ? <NewWithdrawalDialog service={service} today={today} open={newOpen} onOpenChange={setNewOpen} /> : null}
    </div>
  );
}
