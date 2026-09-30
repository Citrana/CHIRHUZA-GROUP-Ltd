"use client";

import { useState } from "react";
import { MapPin, Plus, User } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { DISTRIBUTION_STATUSES, type DistributionStatus } from "../../../convex/lib/distributions";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { NewDistributionDialog } from "@/components/stock/new-distribution-dialog";
import { useCan } from "@/lib/use-can";

type DistributionRow = PaginatedQueryItem<typeof api.distributions.list>;

function Destination({ row }: { row: DistributionRow }) {
  const Icon = row.toType === "user" ? User : MapPin;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-medium">{row.toName ?? "—"}</span>
    </span>
  );
}

/** Distributions list (stock.view) and "New distribution" (stock.distribute). */
export function DistributionsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Distributions");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const canView = useCan("stock.view");
  const canDistribute = useCan("stock.distribute");
  const [status, setStatus] = useState<DistributionStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);
  const { results, pagination } = useCursorPaginatedQuery(
    api.distributions.list,
    canView ? { businessUnitKey: service, ...(status ? { status } : {}) } : "skip",
  );

  if (canView === undefined) return null;
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  });

  const columns: DataTableColumn<DistributionRow>[] = [
    {
      id: "number",
      header: t("numberHeader"),
      cell: ({ row }) => row.original.number,
      meta: { className: "whitespace-nowrap font-mono text-xs font-medium" },
    },
    { id: "to", header: t("toHeader"), cell: ({ row }) => <Destination row={row.original} /> },
    {
      id: "units",
      header: t("unitsHeader"),
      cell: ({ row }) => t("unitsSummary", { units: row.original.totalQty, lines: row.original.lines.length }),
      meta: { hideBelow: "sm", className: "whitespace-nowrap tabular-nums" },
    },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => <ApprovalStatusBadge status={row.original.status} /> },
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => date.format(row.original._creationTime),
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
  ];

  const details = (row: DistributionRow) => (
    <div className="flex flex-col gap-3 text-sm">
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
        {row.lines.map((line) => (
          <li key={line._id} className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0">
              <span className="block font-medium">
                {[
                  line.productName ?? "—",
                  line.lengthInches !== null ? tProducts("inches", { inches: line.lengthInches }) : null,
                  line.colourName,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {[line.sku, line.batchNumber].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="shrink-0 font-medium whitespace-nowrap tabular-nums">
              {t("pieces", { count: line.qty })}
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>{t("requestedBy")}</dt>
        <dd className="text-foreground">{row.createdByName ?? "—"}</dd>
        {row.note ? (
          <>
            <dt>{t("noteLabel")}</dt>
            <dd className="whitespace-pre-wrap text-foreground">{row.note}</dd>
          </>
        ) : null}
        {row.status !== "pending" ? (
          <>
            <dt>{row.status === "approved" ? t("approvedBy") : t("rejectedBy")}</dt>
            <dd className="text-foreground">
              {row.decidedByName ?? "—"}
              {row.decidedAt ? ` · ${date.format(row.decidedAt)}` : null}
              {row.decisionNote ? <span className="block whitespace-pre-wrap">{row.decisionNote}</span> : null}
            </dd>
          </>
        ) : null}
      </dl>
      {row.status === "pending" ? (
        <p className="text-muted-foreground">
          {t("pendingHint")}{" "}
          <Link href={`/${service}/approvals`} className="underline underline-offset-4">
            {t("viewApprovals")}
          </Link>
        </p>
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
        {canDistribute ? (
          <Button onClick={() => setNewOpen(true)}>
            <Plus aria-hidden />
            {t("new")}
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={results}
        getRowId={(d) => d._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        renderExpanded={details}
        toolbar={
          <NativeSelect
            aria-label={t("statusHeader")}
            className="h-10 w-48 sm:h-8"
            value={status}
            onChange={(e) => setStatus(e.target.value as DistributionStatus | "")}
          >
            <option value="">{t("allStatuses")}</option>
            {DISTRIBUTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </NativeSelect>
        }
        renderCard={(d) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Destination row={d} />
              <ApprovalStatusBadge status={d.status} />
            </div>
            <p className="text-xs text-muted-foreground">
              {d.number} · {t("unitsSummary", { units: d.totalQty, lines: d.lines.length })} ·{" "}
              {date.format(d._creationTime)}
            </p>
          </div>
        )}
      />
      {canDistribute ? <NewDistributionDialog service={service} open={newOpen} onOpenChange={setNewOpen} /> : null}
    </div>
  );
}
