"use client";

import { useState } from "react";
import { FilterX, History, SlidersHorizontal } from "lucide-react";
import { useQuery, type PaginatedQueryItem } from "convex/react";
import type { DataTableColumn } from "@/components/data-table/features";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { AUDIT_ACTIONS, type AuditAction } from "../../../convex/lib/audit";
import { snapshotCurrency } from "../../../convex/lib/money";
import {
  BUSINESS_TIME_ZONE,
  businessDayEndUtc,
  businessDayStartUtc,
} from "../../../convex/lib/time";
import { DataTable } from "@/components/data-table/data-table";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ChangesTable } from "@/components/shared/changes-table";
import {
  formatSnapshotValue,
  summarizeAuditEntry,
} from "@/lib/audit-summary";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

type AuditEntry = PaginatedQueryItem<typeof api.auditLogs.list>;

/** Record types that currently write audit entries. */
const ENTITY_TABLES = ["users", "rolePermissions", "locations"] as const;
type EntityTable = (typeof ENTITY_TABLES)[number];

function isEntityTable(table: string): table is EntityTable {
  return (ENTITY_TABLES as readonly string[]).includes(table);
}

const ACTION_VARIANTS: Record<
  AuditAction,
  "default" | "secondary" | "destructive" | "outline"
> = {
  create: "default",
  update: "secondary",
  delete: "destructive",
  approve: "default",
  reject: "destructive",
};

type Filters = {
  actorId: Id<"users"> | "";
  action: AuditAction | "";
  entityTable: EntityTable | "";
  entityId: string;
  fromDay: string;
  toDay: string;
};

const NO_FILTERS: Filters = {
  actorId: "",
  action: "",
  entityTable: "",
  entityId: "",
  fromDay: "",
  toDay: "",
};

/**
 * Read-only view of the append-only audit log: one compact row per entry,
 * expandable to its full before/after. There are deliberately no edit or
 * delete controls - the server exposes no such functions either.
 */
export function AuditLogPanel() {
  const t = useTranslations("AuditLog");
  const locale = useLocale();
  const canView = useCan("audit.view");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const actors = useQuery(api.auditLogs.listActors, canView ? {} : "skip");

  const entityId = filters.entityId.trim();
  const args = {
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entityTable ? { entityTable: filters.entityTable } : {}),
    ...(entityId ? { entityId } : {}),
    // Days are business-time-zone days (Africa/Lubumbashi), per CLAUDE.md.
    ...(filters.fromDay ? { from: businessDayStartUtc(filters.fromDay) } : {}),
    ...(filters.toDay ? { to: businessDayEndUtc(filters.toDay) } : {}),
  };
  const { results, pagination } = useCursorPaginatedQuery(
    api.auditLogs.list,
    canView ? args : "skip"
  );

  if (canView === undefined) {
    return null;
  }
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const activeFilterCount = Object.values(filters).filter((v) => v !== "").length;
  const shortTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const longTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const empty = t("emptyValue");
  const entityLabel = (table: string) =>
    isEntityTable(table) ? t(`entities.${table}`) : table;
  const actorLabel = (entry: AuditEntry) =>
    entry.actorName || entry.actorEmail || t("unknownActor");

  const actionBadge = (entry: AuditEntry) => (
    <Badge variant={ACTION_VARIANTS[entry.action]}>
      {t(`actions.${entry.action}`)}
    </Badge>
  );

  const summaryText = (entry: AuditEntry) => {
    const summary = summarizeAuditEntry(entry);
    if (!summary) return empty;
    const opts = { currency: snapshotCurrency(entry.before, entry.after), locale, empty };
    const value = (v: unknown) => formatSnapshotValue(summary.field, v, opts);
    const body =
      summary.kind === "change"
        ? `${summary.field}: ${value(summary.from)} → ${value(summary.to)}`
        : `${summary.field}: ${value(summary.value)}`;
    return summary.more > 0
      ? `${body} ${t("more", { count: summary.more })}`
      : body;
  };

  const time = (entry: AuditEntry, format: Intl.DateTimeFormat) => (
    <time
      dateTime={new Date(entry.timestamp).toISOString()}
      title={longTime.format(entry.timestamp)}
    >
      {format.format(entry.timestamp)}
    </time>
  );

  const columns: DataTableColumn<AuditEntry>[] = [
    {
      id: "time",
      header: t("timeHeader"),
      cell: ({ row }) => time(row.original, shortTime),
      meta: { className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "who",
      header: t("whoHeader"),
      cell: ({ row }) => actorLabel(row.original),
      meta: { hideBelow: "md", className: "whitespace-nowrap" },
    },
    {
      id: "action",
      header: t("actionHeader"),
      cell: ({ row }) => actionBadge(row.original),
    },
    {
      id: "record",
      header: t("recordHeader"),
      cell: ({ row }) => entityLabel(row.original.entityTable),
      meta: { hideBelow: "lg", className: "whitespace-nowrap" },
    },
    {
      id: "changes",
      header: t("changesHeader"),
      cell: ({ row }) => (
        <span className="line-clamp-1 break-all">{summaryText(row.original)}</span>
      ),
      meta: { className: "w-full max-w-0" },
    },
  ];

  const details = (entry: AuditEntry) => {
    return (
      <div className="flex flex-col gap-3 pt-1 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("timeHeader")}</dt>
          <dd>{time(entry, longTime)}</dd>
          <dt className="text-muted-foreground">{t("whoHeader")}</dt>
          <dd>{actorLabel(entry)}</dd>
          <dt className="text-muted-foreground">{t("recordHeader")}</dt>
          <dd className="min-w-0">
            {entityLabel(entry.entityTable)}{" "}
            <span className="font-mono text-xs break-all text-muted-foreground">
              {entry.entityId}
            </span>
          </dd>
        </dl>
        <ChangesTable before={entry.before} after={entry.after} />
        {entry.reason ? (
          <p>
            <span className="font-medium">{t("reason")}:</span> {entry.reason}
          </p>
        ) : null}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters({
                ...NO_FILTERS,
                entityTable: isEntityTable(entry.entityTable)
                  ? entry.entityTable
                  : "",
                entityId: entry.entityId,
              })
            }
          >
            <History aria-hidden />
            {t("recordHistory")}
          </Button>
        </div>
      </div>
    );
  };

  const card = (entry: AuditEntry) => (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {actionBadge(entry)}
        <span className="font-medium">{entityLabel(entry.entityTable)}</span>
      </div>
      <p className="line-clamp-2 text-sm break-all">{summaryText(entry)}</p>
      <p className="text-xs text-muted-foreground">
        {time(entry, shortTime)} · {actorLabel(entry)}
      </p>
    </div>
  );

  const filterFields = (
    <div
      className={cn(
        "w-full grid-cols-1 gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-3",
        filtersOpen ? "grid" : "hidden md:grid",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="audit-actor">{t("actorLabel")}</Label>
        <NativeSelect
          id="audit-actor"
          value={filters.actorId}
          onChange={(e) => set("actorId", e.target.value as Id<"users"> | "")}
        >
          <option value="">{t("allActors")}</option>
          {actors?.map((actor) => (
            <option key={actor._id} value={actor._id}>
              {actor.name || actor.email}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="audit-action">{t("actionLabel")}</Label>
        <NativeSelect
          id="audit-action"
          value={filters.action}
          onChange={(e) => set("action", e.target.value as AuditAction | "")}
        >
          <option value="">{t("allActions")}</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(`actions.${action}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="audit-entity">{t("entityLabel")}</Label>
        <NativeSelect
          id="audit-entity"
          value={filters.entityTable}
          onChange={(e) => set("entityTable", e.target.value as EntityTable | "")}
        >
          <option value="">{t("allEntities")}</option>
          {ENTITY_TABLES.map((table) => (
            <option key={table} value={table}>
              {t(`entities.${table}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="audit-entity-id">{t("entityIdLabel")}</Label>
        <Input
          id="audit-entity-id"
          value={filters.entityId}
          placeholder={t("entityIdPlaceholder")}
          onChange={(e) => set("entityId", e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="audit-from">{t("fromLabel")}</Label>
        <Input
          id="audit-from"
          type="date"
          value={filters.fromDay}
          max={filters.toDay || undefined}
          onChange={(e) => set("fromDay", e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="audit-to">{t("toLabel")}</Label>
        <Input
          id="audit-to"
          type="date"
          value={filters.toDay}
          min={filters.fromDay || undefined}
          onChange={(e) => set("toDay", e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2 lg:col-span-3">
        <p className="text-xs text-muted-foreground">{t("timeZoneNote")}</p>
        {activeFilterCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
            <FilterX aria-hidden />
            {t("clearFilters")}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <DataTable
        columns={columns}
        data={results}
        getRowId={(entry) => entry._id}
        emptyMessage={t("empty")}
        pagination={{ mode: "server", ...pagination }}
        renderExpanded={details}
        renderCard={card}
        toolbar={
          <>
            {/* Phones: filters fold away behind a toggle. */}
            <Button
              variant="outline"
              className="h-10 self-start md:hidden"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal aria-hidden />
              {activeFilterCount > 0
                ? t("filtersWithCount", { count: activeFilterCount })
                : t("filters")}
            </Button>
            {filterFields}
          </>
        }
      />
    </div>
  );
}
