"use client";

import { Pencil, Plus } from "lucide-react";
import { useQuery } from "convex/react";
import type { DataTableColumn } from "@/components/data-table/features";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { DataTable } from "@/components/data-table/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocationFormDialog } from "@/components/admin/location-form-dialog";
import { useCan } from "@/lib/use-can";

export function LocationsAdminPanel() {
  const t = useTranslations("Admin.locations");
  const canManage = useCan("locations.manage");
  // Locations are global: every one serves every service.
  const locations = useQuery(api.locations.list, canManage ? {} : "skip");

  if (canManage === undefined) {
    return null;
  }
  if (!canManage) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const editButton = (location: Doc<"locations">) => (
    <LocationFormDialog
      location={location}
      trigger={
        <Button variant="outline" size="sm">
          <Pencil aria-hidden />
          {t("edit")}
        </Button>
      }
    />
  );

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
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("sharedHint")}</p>
        </div>
        <LocationFormDialog
          trigger={
            <Button>
              <Plus aria-hidden />
              {t("add")}
            </Button>
          }
        />
      </div>

      <DataTable
        columns={columns}
        data={locations}
        getRowId={(location) => location._id}
        emptyMessage={t("empty")}
        search={{ placeholder: t("searchPlaceholder") }}
        initialSorting={[{ id: "name", desc: false }]}
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
