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
import { CarDialog } from "@/components/fleet/car-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";

type CarRow = FunctionReturnType<typeof api.cars.list>[number];

/** The fleet: every car with its driver; add / edit for transport.fleet.manage. */
export function CarsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Fleet");
  const locale = useLocale();
  const canView = useCan("transport.view");
  const canManage = useCan("transport.fleet.manage");
  const cars = useQuery(api.cars.list, canView ? { businessUnitKey: service } : "skip");
  // null = closed; "new" = adding; a row = editing it.
  const [editing, setEditing] = useState<CarRow | "new" | null>(null);

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const statusBadge = (car: CarRow) =>
    car.status === "active" ? null : <Badge variant="outline">{t(`carStatuses.${car.status}`)}</Badge>;
  const driver = (car: CarRow) =>
    car.driverName ? (
      <span className="flex flex-col">
        <span>{car.driverName}</span>
        {car.driverPhone ? <span className="text-xs text-muted-foreground">{car.driverPhone}</span> : null}
      </span>
    ) : (
      <span className="text-muted-foreground">{t("noDriver")}</span>
    );
  const editButton = (car: CarRow) =>
    canManage ? (
      <Button variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={t("editCar", { plate: car.plateNumber })} onClick={() => setEditing(car)}>
        <Pencil aria-hidden />
      </Button>
    ) : null;

  const columns: DataTableColumn<CarRow>[] = [
    {
      id: "plate",
      header: t("plateLabel"),
      accessorFn: (car) => car.plateNumber,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="font-mono font-medium">{row.original.plateNumber}</span>
          {statusBadge(row.original)}
        </span>
      ),
      meta: { className: "whitespace-nowrap" },
    },
    { id: "model", header: t("modelLabel"), accessorFn: (car) => car.model, meta: { hideBelow: "md" } },
    { id: "driver", header: t("driverLabel"), accessorFn: (car) => car.driverName ?? "", cell: ({ row }) => driver(row.original) },
    {
      id: "rate",
      header: t("driverDayRateHeader"),
      cell: ({ row }) => (row.original.driverDayRate !== null ? money(row.original.driverDayRate) : "—"),
      meta: { hideBelow: "md", className: "whitespace-nowrap tabular-nums" },
    },
    { id: "actions", header: "", cell: ({ row }) => editButton(row.original), meta: { className: "w-12 text-right" } },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("carsTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("carsSubtitle")}</p>
        </div>
        {canManage ? (
          <Button size="lg" className="min-h-11" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            {t("addCar")}
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={cars}
        getRowId={(car) => car._id}
        emptyMessage={t("noCars")}
        search={{ placeholder: t("searchCars") }}
        renderCard={(car) => (
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="font-mono font-medium">{car.plateNumber}</span>
                {statusBadge(car)}
              </span>
              <span className="text-xs text-muted-foreground">{car.model}</span>
              <span className="text-sm">{driver(car)}</span>
            </div>
            {editButton(car)}
          </div>
        )}
      />
      {editing !== null ? (
        <CarDialog
          key={editing === "new" ? "new" : editing._id}
          service={service}
          car={editing === "new" ? null : editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </div>
  );
}
