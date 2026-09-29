"use client";

import { useState } from "react";
import { FilterX } from "lucide-react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { AUDIT_ACTIONS, type AuditAction } from "../../../convex/lib/audit";
import {
  BUSINESS_TIME_ZONE,
  businessDayEndUtc,
  businessDayStartUtc,
} from "../../../convex/lib/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useCan } from "@/lib/use-can";

/** Record types that currently write audit entries. */
const ENTITY_TABLES = ["users", "rolePermissions", "locations"] as const;
type EntityTable = (typeof ENTITY_TABLES)[number];

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

function formatValue(value: unknown, empty: string): string {
  if (value === null || value === undefined) return empty;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Read-only view of the append-only audit log. There are deliberately no
 * edit or delete controls - the server exposes no such functions either.
 */
export function AuditLogPanel() {
  const t = useTranslations("AuditLog");
  const locale = useLocale();
  const canView = useCan("audit.view");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
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
  const { results, status, loadMore } = usePaginatedQuery(
    api.auditLogs.list,
    canView ? args : "skip",
    { initialNumItems: 25 },
  );

  if (canView === undefined) {
    return null;
  }
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  const hasFilters = Object.values(filters).some((v) => v !== "");
  const formatTime = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const empty = t("emptyValue");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
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
            onChange={(e) =>
              set("entityTable", e.target.value as EntityTable | "")
            }
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
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFilters(NO_FILTERS)}
            >
              <FilterX aria-hidden />
              {t("clearFilters")}
            </Button>
          ) : null}
        </div>
      </div>

      {status === "LoadingFirstPage" ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {results.map((entry) => {
            const fields = [
              ...new Set([
                ...Object.keys(entry.before ?? {}),
                ...Object.keys(entry.after ?? {}),
              ]),
            ];
            const entityLabel = (ENTITY_TABLES as readonly string[]).includes(
              entry.entityTable,
            )
              ? t(`entities.${entry.entityTable as EntityTable}`)
              : entry.entityTable;
            return (
              <li
                key={entry._id}
                className="flex flex-col gap-3 rounded-lg border border-border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={ACTION_VARIANTS[entry.action]}>
                    {t(`actions.${entry.action}`)}
                  </Badge>
                  <span className="font-medium">{entityLabel}</span>
                  <button
                    type="button"
                    className="max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                    title={entry.entityId}
                    onClick={() =>
                      setFilters({
                        ...NO_FILTERS,
                        entityTable: (ENTITY_TABLES as readonly string[]).includes(
                          entry.entityTable,
                        )
                          ? (entry.entityTable as EntityTable)
                          : "",
                        entityId: entry.entityId,
                      })
                    }
                  >
                    {entry.entityId}
                  </button>
                </div>
                <p className="text-sm text-muted-foreground">
                  <time dateTime={new Date(entry.timestamp).toISOString()}>
                    {formatTime.format(entry.timestamp)}
                  </time>{" "}
                  ·{" "}
                  {t("by", {
                    name: entry.actorName || entry.actorEmail || t("unknownActor"),
                  })}
                </p>
                {fields.length > 0 ? (
                  <div className="overflow-x-auto rounded-md border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="p-2 text-left font-medium">
                            {t("field")}
                          </th>
                          {entry.before ? (
                            <th className="p-2 text-left font-medium">
                              {t("before")}
                            </th>
                          ) : null}
                          {entry.after ? (
                            <th className="p-2 text-left font-medium">
                              {t("after")}
                            </th>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field) => (
                          <tr key={field} className="border-t border-border">
                            <td className="p-2 font-mono text-xs">{field}</td>
                            {entry.before ? (
                              <td className="p-2 break-all">
                                {formatValue(entry.before[field], empty)}
                              </td>
                            ) : null}
                            {entry.after ? (
                              <td className="p-2 break-all">
                                {formatValue(entry.after[field], empty)}
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {entry.reason ? (
                  <p className="text-sm">
                    <span className="font-medium">{t("reason")}:</span>{" "}
                    {entry.reason}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={status === "LoadingMore"}
          onClick={() => loadMore(25)}
        >
          {status === "LoadingMore" ? t("loading") : t("loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
