"use client";

import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { LocationType } from "../../../convex/lib/businessUnits";
import { DEFAULT_OPEN_DAYS } from "../../../convex/lib/salesDays";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Create (no `location`) or edit a location. Locations are shared by every
 * service and never deleted; untick "Active" to retire one.
 */
export function LocationFormDialog({
  location,
  trigger,
}: {
  location?: Doc<"locations">;
  trigger: ReactElement;
}) {
  const t = useTranslations("Admin.locations");
  const locale = useLocale();
  // Short weekday names in the user's language, Monday first (0 = Sunday).
  const weekdayName = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const WEEK = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, name: weekdayName.format(Date.UTC(2026, 10, 1 + d)) }));
  const create = useMutation(api.locations.create);
  const update = useMutation(api.locations.update);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<LocationType>("shop");
  const [address, setAddress] = useState("");
  const [active, setActive] = useState(true);
  const [openDays, setOpenDays] = useState<number[]>([...DEFAULT_OPEN_DAYS]);
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    setName(location?.name ?? "");
    setType(location?.type ?? "shop");
    setAddress(location?.address ?? "");
    setActive(location?.active ?? true);
    setOpenDays([...(location?.openDays ?? DEFAULT_OPEN_DAYS)]);
    setError(false);
    setSubmitting(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(false);
    setSubmitting(true);
    try {
      const fields = { name, type, address, active, openDays };
      if (location) {
        await update({ locationId: location._id, ...fields });
      } else {
        await create(fields);
      }
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  const idPrefix = location ? `location-${location._id}` : "location-new";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) load();
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {location ? t("editTitle") : t("createTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${idPrefix}-name`} required>{t("nameLabel")}</Label>
              <Input
                id={`${idPrefix}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${idPrefix}-type`}>{t("typeLabel")}</Label>
              <NativeSelect
                id={`${idPrefix}-type`}
                value={type}
                onChange={(event) => setType(event.target.value as LocationType)}
              >
                <option value="shop">{t("typeShop")}</option>
                <option value="warehouse">{t("typeWarehouse")}</option>
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${idPrefix}-address`}>{t("addressLabel")}</Label>
              <Input
                id={`${idPrefix}-address`}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </div>
            {type === "shop" ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">{t("openDaysLabel")}</legend>
                <div className="grid grid-cols-7 gap-1">
                  {WEEK.map(({ d, name: dayName }) => {
                    const on = openDays.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setOpenDays((days) => (on ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b)))
                        }
                        className={cn(
                          "min-h-11 rounded-md border text-xs font-medium capitalize",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {dayName}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">{openDays.length === 0 ? t("openDaysNone") : t("openDaysHint")}</p>
              </fieldset>
            ) : null}
            <div className="flex flex-col gap-1">
              <label
                htmlFor={`${idPrefix}-active`}
                className="flex items-center gap-2 text-sm font-medium"
              >
                <input
                  id={`${idPrefix}-active`}
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={active}
                  onChange={(event) => setActive(event.target.checked)}
                />
                {t("activeLabel")}
              </label>
              <p className="text-xs text-muted-foreground">{t("activeHint")}</p>
            </div>
            {error ? (
              <p className="text-sm text-destructive">{t("saveError")}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || openDays.length === 0}>
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
