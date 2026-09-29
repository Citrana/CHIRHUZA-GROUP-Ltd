"use client";

import { useState } from "react";
import { FilterX, SlidersHorizontal, UserRound } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  type ApprovalStatus,
  type ApprovalType,
} from "../../../convex/lib/approvalTypes";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import {
  BUSINESS_TIME_ZONE,
  businessDayEndUtc,
  businessDayStartUtc,
} from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ApprovalDrawer } from "@/components/approvals/approval-drawer";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { cn } from "@/lib/utils";

type ApprovalRow = PaginatedQueryItem<typeof api.approvals.list>;

type Filters = {
  requestedByMe: boolean;
  type: ApprovalType | "";
  status: ApprovalStatus | "";
  fromDay: string;
  toDay: string;
};

// Pending first: that's what people come here to act on.
const DEFAULT_FILTERS: Filters = {
  requestedByMe: false,
  type: "",
  status: "pending",
  fromDay: "",
  toDay: "",
};

/**
 * The service's approvals: everything for approvals.view_all, otherwise the
 * user's own requests plus what they may decide (filtered on the server).
 */
export function ApprovalsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Approvals");
  const locale = useLocale();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openId, setOpenId] = useState<Id<"approvals"> | null>(null);

  const { results, pagination } = useCursorPaginatedQuery(
    api.approvals.list,
    {
      businessUnitKey: service,
      ...(filters.requestedByMe ? { requestedByMe: true } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      // Business-time-zone days (Africa/Lubumbashi), per CLAUDE.md.
      ...(filters.fromDay ? { from: businessDayStartUtc(filters.fromDay) } : {}),
      ...(filters.toDay ? { to: businessDayEndUtc(filters.toDay) } : {}),
    },
    { initialPageSize: 25 },
  );

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const changedFilterCount = (Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]).filter(
    (key) => filters[key] !== DEFAULT_FILTERS[key],
  ).length;
  const shortTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const requester = (row: ApprovalRow) => row.requesterName ?? t("unknownUser");

  const columns: DataTableColumn<ApprovalRow>[] = [
    {
      id: "requested",
      header: t("requestedHeader"),
      cell: ({ row }) => shortTime.format(row.original._creationTime),
      meta: { className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "type",
      header: t("typeHeader"),
      cell: ({ row }) => t(`types.${row.original.type}`),
      meta: { className: "whitespace-nowrap font-medium" },
    },
    {
      id: "requester",
      header: t("requesterHeader"),
      cell: ({ row }) => requester(row.original),
      meta: { hideBelow: "md", className: "whitespace-nowrap" },
    },
    {
      id: "status",
      header: t("statusHeader"),
      cell: ({ row }) => <ApprovalStatusBadge status={row.original.status} />,
    },
    {
      id: "reason",
      header: t("reasonHeader"),
      cell: ({ row }) => (
        <span className="line-clamp-1 text-muted-foreground">
          {row.original.reason || t("noReason")}
        </span>
      ),
      meta: { hideBelow: "lg", className: "w-full max-w-0" },
    },
  ];

  const filterFields = (
    <div
      className={cn(
        "w-full grid-cols-1 gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-4",
        filtersOpen ? "grid" : "hidden md:grid",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="approvals-status">{t("statusLabel")}</Label>
        <NativeSelect
          id="approvals-status"
          value={filters.status}
          onChange={(e) => set("status", e.target.value as ApprovalStatus | "")}
        >
          <option value="">{t("allStatuses")}</option>
          {APPROVAL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`statuses.${status}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="approvals-type">{t("typeLabel")}</Label>
        <NativeSelect
          id="approvals-type"
          value={filters.type}
          onChange={(e) => set("type", e.target.value as ApprovalType | "")}
        >
          <option value="">{t("allTypes")}</option>
          {APPROVAL_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`types.${type}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="approvals-from">{t("fromLabel")}</Label>
        <Input
          id="approvals-from"
          type="date"
          value={filters.fromDay}
          max={filters.toDay || undefined}
          onChange={(e) => set("fromDay", e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="approvals-to">{t("toLabel")}</Label>
        <Input
          id="approvals-to"
          type="date"
          value={filters.toDay}
          min={filters.fromDay || undefined}
          onChange={(e) => set("toDay", e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2 lg:col-span-4">
        <p className="text-xs text-muted-foreground">{t("timeZoneNote")}</p>
        {changedFilterCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
            <FilterX aria-hidden />
            {t("resetFilters")}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <DataTable
        columns={columns}
        data={results}
        getRowId={(row) => row._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        onRowClick={(row) => setOpenId(row._id)}
        renderCard={(row) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t(`types.${row.type}`)}</span>
              <ApprovalStatusBadge status={row.status} />
            </div>
            {row.reason ? (
              <p className="line-clamp-2 text-sm">{row.reason}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {shortTime.format(row._creationTime)} · {requester(row)}
            </p>
          </div>
        )}
        toolbar={
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={filters.requestedByMe ? "default" : "outline"}
                className="h-10 sm:h-8"
                aria-pressed={filters.requestedByMe}
                onClick={() => set("requestedByMe", !filters.requestedByMe)}
              >
                <UserRound aria-hidden />
                {t("requestedByMe")}
              </Button>
              <Button
                variant="outline"
                className="h-10 md:hidden"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal aria-hidden />
                {changedFilterCount > 0
                  ? t("filtersWithCount", { count: changedFilterCount })
                  : t("filters")}
              </Button>
            </div>
            {filterFields}
          </>
        }
      />

      <ApprovalDrawer approvalId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
