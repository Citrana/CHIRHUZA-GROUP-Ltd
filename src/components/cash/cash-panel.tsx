"use client";

import { useState, type FormEvent } from "react";
import { Download, Plus, Undo2 } from "lucide-react";
import { ConvexError } from "convex/values";
import { useConvex, useMutation, useQuery, type PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { OPENING_CASH_STATUSES, type OpeningCashStatus } from "../../../convex/lib/openingCash";
import { BUSINESS_TIME_ZONE, businessDayOf } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { DateRangeFilter, useDateRangeLabel } from "@/components/filters/date-range-filter";
import { FilterField } from "@/components/filters/filter-field";
import { FilterPanel, type FilterChip } from "@/components/filters/filter-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { NewOpeningCashDialog } from "@/components/cash/new-opening-cash-dialog";
import { ReverseOpeningCashDialog } from "@/components/cash/reverse-opening-cash-dialog";
import { downloadCsv } from "@/lib/csv";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type OpeningCashRow = PaginatedQueryItem<typeof api.cash.listOpeningCash>;
type Filters = { from: string; to: string; locationId: string; status: OpeningCashStatus | "" };
const NO_FILTERS: Filters = { from: "", to: "", locationId: "", status: "" };

/**
 * Cash on hand (opening cash, cash sales, cash credit payments, refunds and
 * withdrawals, each on its own line) and the opening cash list: totals,
 * date / location / status filters, CSV export, record and reverse. Never
 * part of sales or profit. Owner only by default.
 */
export function CashPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Cash");
  const locale = useLocale();
  const convex = useConvex();
  const canView = useCan("cash.view");
  const canRecord = useCan("cash.opening.record");
  const canSettings = useCan("cash.settings");
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [newOpen, setNewOpen] = useState(false);
  const [reversing, setReversing] = useState<{ id: Id<"openingCash">; label: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [today] = useState(() => businessDayOf(Date.now()));
  const dateLabel = useDateRangeLabel();
  const { from, to, locationId, status } = applied;
  const filters = {
    businessUnitKey: service,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(locationId ? { locationId: locationId as Id<"locations"> } : {}),
    ...(status ? { status } : {}),
  };
  const cash = useQuery(
    api.cash.onHand,
    canView ? { businessUnitKey: service, ...(locationId ? { locationId: locationId as Id<"locations"> } : {}) } : "skip",
  );
  const totals = useQuery(api.cash.openingCashTotals, canView ? filters : "skip");
  const options = useQuery(api.cash.options, canRecord ? { businessUnitKey: service } : "skip");
  const { results, pagination } = useCursorPaginatedQuery(api.cash.listOpeningCash, canView ? filters : "skip");

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: BUSINESS_TIME_ZONE });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const filterLocations = options && !options.locked ? options.locations : [];
  const signed = (row: { kind: "record" | "reversal"; amount: number }) => (row.kind === "reversal" ? -row.amount : row.amount);
  const kindLabel = (row: { kind: "record" | "reversal" }) => t(`kinds.${row.kind}`);

  const chips = (f: Filters): FilterChip<Filters>[] => {
    const list: FilterChip<Filters>[] = [];
    const dates = dateLabel(f);
    if (dates) list.push({ id: "dates", label: dates, clear: (v) => ({ ...v, from: "", to: "" }) });
    const location = f.locationId ? filterLocations.find((l) => l._id === f.locationId) : undefined;
    if (location) list.push({ id: "location", label: location.name, clear: (v) => ({ ...v, locationId: "" }) });
    if (f.status) list.push({ id: "status", label: t(`statuses.${f.status}`), clear: (v) => ({ ...v, status: "" }) });
    return list;
  };

  async function exportCsv() {
    setExporting(true);
    try {
      const rows = await convex.query(api.cash.exportOpeningCash, filters);
      const range = from || to ? `-${from || "start"}_${to || today}` : `-${today}`;
      downloadCsv(`opening-cash-${service}${range}.csv`, [
        [t("csv.date"), t("csv.kind"), t("csv.amount"), t("csv.receivedBy"), t("csv.location"), t("csv.note"), t("csv.status"), t("csv.recordedBy")],
        ...rows.map((r) => [
          businessDayOf(r.date),
          kindLabel(r),
          (signed(r) / 100).toFixed(2),
          r.receivedByName,
          r.locationName ?? t("noLocation"),
          r.kind === "reversal" ? (r.reason ?? "") : (r.note ?? ""),
          t(`statuses.${r.status}`),
          r.requestedByName ?? "",
        ]),
      ]);
    } finally {
      setExporting(false);
    }
  }

  const canReverse = (row: OpeningCashRow) => canRecord && row.kind === "record" && row.status === "approved" && !row.reversal;

  const columns: DataTableColumn<OpeningCashRow>[] = [
    { id: "date", header: t("dateHeader"), cell: ({ row }) => day.format(row.original.date), meta: { className: "whitespace-nowrap" } },
    {
      id: "amount",
      header: t("amountHeader"),
      cell: ({ row }) => (
        <span className={cn(row.original.kind === "reversal" && "text-destructive")}>{money(signed(row.original))}</span>
      ),
      meta: { className: "whitespace-nowrap tabular-nums font-medium" },
    },
    { id: "receivedBy", header: t("receivedByHeader"), cell: ({ row }) => row.original.receivedByName },
    {
      id: "kind",
      header: t("kindHeader"),
      cell: ({ row }) => (row.original.reversal?.status === "approved" ? t("reversed") : kindLabel(row.original)),
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

  const details = (row: OpeningCashRow) => (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {row.kind === "record" ? (
          <>
            <dt>{t("noteLabel")}</dt>
            <dd className="whitespace-pre-wrap text-foreground">{row.note}</dd>
          </>
        ) : (
          <>
            <dt>{t("reasonLabel")}</dt>
            <dd className="whitespace-pre-wrap text-foreground">{row.reason}</dd>
            {row.reverses ? (
              <>
                <dt>{t("reversesLabel")}</dt>
                <dd className="text-foreground">
                  {day.format(row.reverses.date)}
                  {row.reverses.note ? ` · ${row.reverses.note}` : null}
                </dd>
              </>
            ) : null}
          </>
        )}
        <dt>{t("recordedBy")}</dt>
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
        ) : row.approvalId ? (
          <>
            <dt>{row.status === "approved" ? t("approvedBy") : t("rejectedBy")}</dt>
            <dd className="text-foreground">
              {row.decidedByName ?? "—"}
              {row.decidedAt ? ` · ${time.format(row.decidedAt)}` : null}
              {row.decisionNote ? <span className="block whitespace-pre-wrap">{row.decisionNote}</span> : null}
            </dd>
          </>
        ) : null}
        {row.reversal ? (
          <>
            <dt>{t("reversalLabel")}</dt>
            <dd className="text-foreground">
              {t(`reversalStatus.${row.reversal.status}`)}
              {row.reversal.reason ? <span className="block whitespace-pre-wrap">{row.reversal.reason}</span> : null}
            </dd>
          </>
        ) : null}
      </dl>
      {canReverse(row) ? (
        <Button
          variant="outline"
          className="min-h-11 self-start"
          onClick={() => setReversing({ id: row._id, label: `${money(row.amount)} · ${day.format(row.date)}` })}
        >
          <Undo2 aria-hidden />
          {t("reverse")}
        </Button>
      ) : null}
    </div>
  );

  const lines = cash
    ? ([
        { key: "openingCash", amount: cash.openingCash },
        { key: "cashSales", amount: cash.cashSales },
        { key: "cashCreditPayments", amount: cash.cashCreditPayments },
        { key: "cashRefunds", amount: -cash.cashRefunds },
        { key: "withdrawals", amount: -cash.withdrawals },
      ] as const)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canRecord ? (
          <Button size="lg" className="min-h-11" onClick={() => setNewOpen(true)}>
            <Plus aria-hidden />
            {t("new")}
          </Button>
        ) : null}
      </div>

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:max-w-md" aria-labelledby="cash-on-hand">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="cash-on-hand" className="text-sm font-medium text-muted-foreground">
            {t("onHandTitle")}
          </h2>
          <p className="text-2xl font-semibold tabular-nums">{cash ? money(cash.total) : "—"}</p>
        </div>
        <dl className="flex flex-col gap-1.5 text-sm">
          {lines.map((line) => (
            <div key={line.key} className="flex items-baseline justify-between gap-3">
              <dt className={cn("text-muted-foreground", line.key === "openingCash" && "font-medium text-foreground")}>
                {t(`lines.${line.key}`)}
              </dt>
              <dd className="tabular-nums">{money(line.amount)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{t("onHandHint")}</p>
      </section>

      {canSettings ? <ThresholdForm service={service} /> : null}

      <section className="flex flex-col gap-3" aria-labelledby="opening-cash">
        <h2 id="opening-cash" className="font-heading text-lg font-semibold">
          {t("openingTitle")}
        </h2>
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
        <p className="text-xs text-muted-foreground">{t("notInProfit")}</p>

        <DataTable
          columns={columns}
          data={results}
          getRowId={(r) => r._id}
          emptyMessage={t("empty")}
          pagination={{ mode: "server", ...pagination }}
          renderExpanded={details}
          toolbar={
            <div className="flex w-full flex-wrap items-center gap-2">
              <FilterPanel value={applied} onApply={setApplied} emptyValue={NO_FILTERS} chips={chips}>
                {(draft, setDraft) => (
                  <>
                    <DateRangeFilter
                      id="opening-cash-dates"
                      value={draft}
                      onChange={(range) => setDraft({ ...draft, from: range.from, to: range.to })}
                    />
                    {filterLocations.length > 0 ? (
                      <FilterField id="opening-cash-location-filter" label={t("locationHeader")}>
                        <NativeSelect
                          id="opening-cash-location-filter"
                          value={draft.locationId}
                          onChange={(e) => setDraft({ ...draft, locationId: e.target.value })}
                          className="h-11 w-full sm:h-8"
                        >
                          <option value="">{t("allLocations")}</option>
                          {filterLocations.map((l) => (
                            <option key={l._id} value={l._id}>
                              {l.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </FilterField>
                    ) : null}
                    <FilterField id="opening-cash-status-filter" label={t("statusHeader")}>
                      <NativeSelect
                        id="opening-cash-status-filter"
                        value={draft.status}
                        onChange={(e) => setDraft({ ...draft, status: e.target.value as OpeningCashStatus | "" })}
                        className="h-11 w-full sm:h-8"
                      >
                        <option value="">{t("allStatuses")}</option>
                        {OPENING_CASH_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`statuses.${s}`)}
                          </option>
                        ))}
                      </NativeSelect>
                    </FilterField>
                  </>
                )}
              </FilterPanel>
              <Button
                variant="outline"
                className="ml-auto min-h-10"
                disabled={exporting || !totals || totals.count === 0}
                onClick={exportCsv}
              >
                <Download aria-hidden />
                {t("download")}
              </Button>
            </div>
          }
          renderCard={(r) => (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{r.receivedByName}</span>
                <span className={cn("font-semibold tabular-nums", r.kind === "reversal" && "text-destructive")}>{money(signed(r))}</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">{r.kind === "reversal" ? r.reason : r.note}</p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {day.format(r.date)} · {r.reversal?.status === "approved" ? t("reversed") : kindLabel(r)}
                </p>
                <ApprovalStatusBadge status={r.status} />
              </div>
            </div>
          )}
        />
      </section>

      {canRecord ? <NewOpeningCashDialog service={service} today={today} open={newOpen} onOpenChange={setNewOpen} /> : null}
      <ReverseOpeningCashDialog target={reversing} onClose={() => setReversing(null)} />
    </div>
  );
}

/** The approval threshold: opening cash (or a reversal) above it waits in Approvals. */
function ThresholdForm({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Cash");
  const locale = useLocale();
  const settings = useQuery(api.cash.getSettings, { businessUnitKey: service });
  const save = useMutation(api.cash.setOpeningCashThreshold);
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!settings) return null;
  const value = draft === undefined ? settings.openingCashApprovalThreshold : draft;
  const changed = value !== settings.openingCashApprovalThreshold;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await save({ businessUnitKey: service, threshold: value ?? 0 });
      setDraft(undefined);
    } catch (e) {
      const data = e instanceof ConvexError ? e.data : null;
      setError(typeof data === "string" ? data : t("saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:max-w-md">
      <Label htmlFor="opening-cash-threshold">{t("thresholdLabel")}</Label>
      <div className="flex gap-2">
        <MoneyInput id="opening-cash-threshold" currency="USD" valueMinor={value} onCommit={setDraft} className="h-11 flex-1" />
        <Button type="submit" variant="outline" className="min-h-11" disabled={!changed || saving}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("thresholdHint", { threshold: formatMoney(settings.openingCashApprovalThreshold, "USD", locale) })}
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
