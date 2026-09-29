"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useQuery } from "convex/react";
import type { DataTableColumn } from "@/components/data-table/features";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { DataTable } from "@/components/data-table/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { LocationFormDialog } from "@/components/admin/location-form-dialog";
import { useLastService } from "@/lib/service-store";
import { useCan } from "@/lib/use-can";

export function LocationsAdminPanel() {
  const t = useTranslations("Admin.locations");
  const tUnits = useTranslations("BusinessUnits");
  const canManage = useCan("locations.manage");
  const lastService = useLastService();
  const units = useQuery(api.businessUnits.list, canManage ? {} : "skip");
  const [selected, setSelected] = useState<BusinessUnitKey | null>(null);
  const unitKey = selected ?? lastService ?? "hair";
  const unit = units?.find((u) => u.key === unitKey);
  const locations = useQuery(
    api.locations.list,
    canManage && unit ? { businessUnitId: unit._id } : "skip",
  );

  if (canManage === undefined) {
    return null;
  }
  if (!canManage) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const editButton = (location: Doc<"locations">) =>
    unit ? (
      <LocationFormDialog
        businessUnitId={unit._id}
        location={location}
        trigger={
          <Button variant="outline" size="sm">
            <Pencil aria-hidden />
            {t("edit")}
          </Button>
        }
      />
    ) : null;

  const typeLabel = (location: Doc<"locations">) =>
    location.type === "shop" ? t("typeShop") : t("typeWarehouse");

  const statusBadge = (location: Doc<"locations">) => (
    <Badge variant={location.active ? "secondary" : "outline"}>
      {location.active ? t("statusActive") : t("statusInactive")}
    </Badge>
  );

  const columns: DataTableColumn<Doc<"locations">>[] = [
    {
      accessorKey: "name",
      header: t("nameHeader"),
      enableSorting: true,
      meta: { className: "font-medium" },
    },
    {
      id: "type",
      // Filter and sort on the translated label.
      accessorFn: typeLabel,
      header: t("typeHeader"),
      enableSorting: true,
    },
    {
      accessorKey: "address",
      header: t("addressHeader"),
      meta: { className: "text-muted-foreground" },
    },
    {
      id: "status",
      accessorFn: (location) =>
        location.active ? t("statusActive") : t("statusInactive"),
      header: t("statusHeader"),
      enableSorting: true,
      cell: ({ row }) => statusBadge(row.original),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("actionsHeader")}</span>,
      cell: ({ row }) => editButton(row.original),
      meta: { className: "text-right" },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-bold text-primary">
          {t("title")}
        </h1>
        {unit ? (
          <LocationFormDialog
            businessUnitId={unit._id}
            trigger={
              <Button>
                <Plus aria-hidden />
                {t("add")}
              </Button>
            }
          />
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={locations}
        getRowId={(location) => location._id}
        emptyMessage={t("empty")}
        search={{ placeholder: t("searchPlaceholder") }}
        initialSorting={[{ id: "name", desc: false }]}
        toolbar={
          <div className="flex flex-col gap-1.5 sm:w-56">
            <Label htmlFor="locations-unit">{t("businessUnitLabel")}</Label>
            <NativeSelect
              id="locations-unit"
              className="h-10 sm:h-8"
              value={unitKey}
              onChange={(event) =>
                setSelected(event.target.value as BusinessUnitKey)
              }
            >
              {units?.map((u) => (
                <option key={u.key} value={u.key}>
                  {tUnits(u.key)}
                </option>
              ))}
            </NativeSelect>
          </div>
        }
        renderCard={(location) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{location.name}</p>
                <p className="text-sm text-muted-foreground">
                  {typeLabel(location)}
                </p>
              </div>
              {statusBadge(location)}
            </div>
            {location.address ? (
              <p className="text-sm text-muted-foreground">{location.address}</p>
            ) : null}
            <div>{editButton(location)}</div>
          </div>
        )}
      />
    </div>
  );
}
