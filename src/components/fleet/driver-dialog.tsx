"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { DRIVER_STATUSES, type DriverStatus } from "../../../convex/lib/transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Add a driver, or edit one (`driver` given): name, phone, pay per day
 * and - when editing - active or inactive. Mounted with a `key` per driver.
 */
export function DriverDialog({
  service,
  driver,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  driver: Doc<"drivers"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Fleet");
  const create = useMutation(api.drivers.create);
  const update = useMutation(api.drivers.update);
  const [name, setName] = useState(driver?.name ?? "");
  const [phone, setPhone] = useState(driver?.phone ?? "");
  const [dayRate, setDayRate] = useState<number | null>(driver?.dayRate ?? null);
  const [status, setStatus] = useState<DriverStatus>(driver?.status ?? "active");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || dayRate === null) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const fields = { name, dayRate, ...(phone.trim() ? { phone } : {}) };
      if (driver) {
        await update({ driverId: driver._id, ...fields, status });
      } else {
        await create({ businessUnitKey: service, ...fields });
      }
      onOpenChange(false);
    } catch (e) {
      const data = e instanceof ConvexError ? e.data : null;
      setError(typeof data === "string" ? data : t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{driver ? t("editDriverTitle", { name: driver.name }) : t("newDriverTitle")}</DialogTitle>
            <DialogDescription>{t("driverHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="flex flex-col gap-2">
              <Label htmlFor="driver-name" required>
                {t("nameLabel")}
              </Label>
              <Input id="driver-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className="h-11" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="driver-phone">{t("phoneLabel")}</Label>
                <Input id="driver-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} className="h-11" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="driver-rate" required>
                  {t("dayRateLabel")}
                </Label>
                <MoneyInput id="driver-rate" currency="USD" valueMinor={dayRate} onCommit={setDayRate} required className="h-11" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("dayRateHint")}</p>
            {driver ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="driver-status" required>
                  {t("statusLabel")}
                </Label>
                <NativeSelect id="driver-status" value={status} onChange={(e) => setStatus(e.target.value as DriverStatus)} className="h-11 w-full">
                  {DRIVER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`driverStatuses.${s}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-11 sm:h-9">
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
