"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { DriverDialog } from "@/components/fleet/driver-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";

type DriverRow = FunctionReturnType<typeof api.drivers.list>[number];

/** The drivers, their pay per day and the car each drives; add / edit for transport.fleet.manage. */
export function DriversPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Fleet");
  const locale = useLocale();
  const canView = useCan("transport.view");
  const canManage = useCan("transport.fleet.manage");
  const drivers = useQuery(api.drivers.list, canView ? { businessUnitKey: service } : "skip");
  const [editing, setEditing] = useState<DriverRow | "new" | null>(null);

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const statusBadge = (d: DriverRow) =>
    d.status === "active" ? null : <Badge variant="outline">{t(`driverStatuses.${d.status}`)}</Badge>;
  const editButton = (d: DriverRow) =>
    canManage ? (
      <Button variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={t("editDriver", { name: d.name })} onClick={() => setEditing(d)}>
        <Pencil aria-hidden />
      </Button>
    ) : null;

  const columns: DataTableColumn<DriverRow>[] = [
    {
      id: "name",
      header: t("nameLabel"),
      accessorFn: (d) => d.name,
      cell: ({ row }) => (
        <span className="flex items-center gap-2 font-medium">
          {row.original.name}
          {statusBadge(row.original)}
        </span>
      ),
    },
    { id: "phone", header: t("phoneLabel"), accessorFn: (d) => d.phone ?? "", cell: ({ row }) => row.original.phone ?? "—", meta: { hideBelow: "md" } },
    {
      id: "rate",
      header: t("dayRateLabel"),
      cell: ({ row }) => money(row.original.dayRate),
      meta: { className: "whitespace-nowrap tabular-nums" },
    },
    {
      id: "car",
      header: t("carHeader"),
      accessorFn: (d) => d.carPlate ?? "",
      cell: ({ row }) => (row.original.carPlate ? <span className="font-mono">{row.original.carPlate}</span> : "—"),
      meta: { hideBelow: "sm" },
    },
    { id: "actions", header: "", cell: ({ row }) => editButton(row.original), meta: { className: "w-12 text-right" } },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("driversTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("driversSubtitle")}</p>
        </div>
        {canManage ? (
          <Button size="lg" className="min-h-11" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            {t("addDriver")}
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={drivers}
        getRowId={(d) => d._id}
        emptyMessage={t("noDrivers")}
        search={{ placeholder: t("searchDrivers") }}
        renderCard={(d) => (
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2 font-medium">
                {d.name}
                {statusBadge(d)}
              </span>
              <span className="text-xs text-muted-foreground">
                {[d.phone, d.carPlate, t("perDay", { amount: money(d.dayRate) })].filter(Boolean).join(" · ")}
              </span>
            </div>
            {editButton(d)}
          </div>
        )}
      />
      {editing !== null ? (
        <DriverDialog
          key={editing === "new" ? "new" : editing._id}
          service={service}
          driver={editing === "new" ? null : editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </div>
  );
}
