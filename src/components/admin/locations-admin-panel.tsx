"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
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

      <div className="flex max-w-xs flex-col gap-2">
        <Label htmlFor="locations-unit">{t("businessUnitLabel")}</Label>
        <NativeSelect
          id="locations-unit"
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

      {locations?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : null}

      {/* Phones: one card per location. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {locations?.map((location) => (
          <li
            key={location._id}
            className="flex flex-col gap-2 rounded-lg border border-border p-4"
          >
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
          </li>
        ))}
      </ul>

      {/* md and up: a table. */}
      {locations && locations.length > 0 ? (
        <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-secondary-foreground">
              <tr>
                <th className="p-3 text-left font-medium">{t("nameHeader")}</th>
                <th className="p-3 text-left font-medium">{t("typeHeader")}</th>
                <th className="p-3 text-left font-medium">
                  {t("addressHeader")}
                </th>
                <th className="p-3 text-left font-medium">
                  {t("statusHeader")}
                </th>
                <th className="p-3 text-right font-medium">
                  {t("actionsHeader")}
                </th>
              </tr>
            </thead>
            <tbody>
              {locations.map((location) => (
                <tr key={location._id} className="border-t border-border">
                  <td className="p-3 font-medium">{location.name}</td>
                  <td className="p-3">{typeLabel(location)}</td>
                  <td className="p-3 text-muted-foreground">
                    {location.address}
                  </td>
                  <td className="p-3">{statusBadge(location)}</td>
                  <td className="p-3 text-right">{editButton(location)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
