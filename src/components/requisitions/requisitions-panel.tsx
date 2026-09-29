"use client";

import { useState } from "react";
import { PackageCheck, Plus } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import {
  REQUISITION_STATUSES,
  type RequisitionStatus,
} from "../../../convex/lib/requisitions";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { useRouter } from "@/i18n/navigation";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { NewRequisitionDialog } from "@/components/requisitions/new-requisition-dialog";
import { RequisitionStatusBadge } from "@/components/requisitions/requisition-status-badge";
import { useCan } from "@/lib/use-can";

type RequisitionRow = PaginatedQueryItem<typeof api.requisitions.list>;

/**
 * The service's requisitions. With requisition.view: all of them (drafts
 * included); otherwise the user's own. "Ready to purchase" = approved.
 */
export function RequisitionsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Requisitions");
  const locale = useLocale();
  const router = useRouter();
  const canView = useCan("requisition.view");
  const canCreate = useCan("requisition.create");
  const allowed = canView || canCreate;
  const [status, setStatus] = useState<RequisitionStatus | "">("");
  const [newOpen, setNewOpen] = useState(false);

  const { results, pagination } = useCursorPaginatedQuery(
    api.requisitions.list,
    allowed ? { businessUnitKey: service, ...(status ? { status } : {}) } : "skip",
  );

  if (canView === undefined || canCreate === undefined) return null;
  if (!allowed) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const readyToPurchase = status === "approved";

  const columns: DataTableColumn<RequisitionRow>[] = [
    {
      id: "number",
      header: t("numberHeader"),
      cell: ({ row }) => row.original.number,
      meta: { className: "whitespace-nowrap font-mono text-xs font-medium" },
    },
    {
      id: "location",
      header: t("locationHeader"),
      cell: ({ row }) => row.original.locationName ?? "—",
      meta: { className: "whitespace-nowrap" },
    },
    {
      id: "status",
      header: t("statusHeader"),
      cell: ({ row }) => <RequisitionStatusBadge status={row.original.status} />,
    },
    {
      id: "items",
      header: t("itemsHeader"),
      cell: ({ row }) => t("itemCount", { count: row.original.itemCount }),
      meta: { hideBelow: "sm", className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "createdBy",
      header: t("createdByHeader"),
      cell: ({ row }) => row.original.createdByName ?? "—",
      meta: { hideBelow: "md", className: "whitespace-nowrap" },
    },
    {
      id: "date",
      header: t("dateHeader"),
      cell: ({ row }) => date.format(row.original._creationTime),
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canCreate ? (
          <Button onClick={() => setNewOpen(true)}>
            <Plus aria-hidden />
            {t("new")}
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={results}
        getRowId={(r) => r._id}
        emptyMessage={readyToPurchase ? t("emptyReady") : t("empty")}
        pagination={{ mode: "server", ...pagination }}
        onRowClick={(r) => router.push(`/${service}/requisitions/${r._id}`)}
        toolbar={
          <div className="flex flex-wrap gap-2">
            <Button
              variant={readyToPurchase ? "default" : "outline"}
              className="h-10 sm:h-8"
              aria-pressed={readyToPurchase}
              onClick={() => setStatus(readyToPurchase ? "" : "approved")}
            >
              <PackageCheck aria-hidden />
              {t("readyToPurchase")}
            </Button>
            <NativeSelect
              aria-label={t("statusHeader")}
              className="h-10 w-48 sm:h-8"
              value={status}
              onChange={(e) => setStatus(e.target.value as RequisitionStatus | "")}
            >
              <option value="">{t("allStatuses")}</option>
              {REQUISITION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`statuses.${s}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        }
        renderCard={(r) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-medium">{r.number}</span>
              <RequisitionStatusBadge status={r.status} />
            </div>
            <p className="text-sm">{r.locationName ?? "—"}</p>
            <p className="text-xs text-muted-foreground">
              {t("itemCount", { count: r.itemCount })} · {r.createdByName ?? "—"} ·{" "}
              {date.format(r._creationTime)}
            </p>
          </div>
        )}
      />

      <NewRequisitionDialog service={service} open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
