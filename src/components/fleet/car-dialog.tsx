"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { CAR_STATUSES, type CarStatus } from "../../../convex/lib/transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";

const DEFAULT_MODEL = "Land Cruiser";

/**
 * Add a car, or edit one (`car` given): plate, model, driver, note, and -
 * when editing - retire it or bring it back. Mounted with a `key` per car,
 * so the form starts from that car.
 */
export function CarDialog({
  service,
  car,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  car: Doc<"cars"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Fleet");
  const drivers = useQuery(api.drivers.list, open ? { businessUnitKey: service } : "skip");
  const create = useMutation(api.cars.create);
  const update = useMutation(api.cars.update);
  const [plateNumber, setPlateNumber] = useState(car?.plateNumber ?? "");
  const [model, setModel] = useState(car?.model ?? DEFAULT_MODEL);
  const [driverId, setDriverId] = useState<string>(car?.driverId ?? "");
  const [status, setStatus] = useState<CarStatus>(car?.status ?? "active");
  const [note, setNote] = useState(car?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Active drivers who don't drive another active car (or drive this one).
  const choices = (drivers ?? []).filter(
    (d) => d.status === "active" && (d.carPlate === null || d._id === car?.driverId),
  );

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!plateNumber.trim() || !model.trim()) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const fields = { plateNumber, model, ...(note.trim() ? { note } : {}) };
      if (car) {
        await update({ carId: car._id, ...fields, driverId: driverId ? (driverId as Id<"drivers">) : null, status });
      } else {
        await create({ businessUnitKey: service, ...fields, ...(driverId ? { driverId: driverId as Id<"drivers"> } : {}) });
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
            <DialogTitle>{car ? t("editCarTitle", { plate: car.plateNumber }) : t("newCarTitle")}</DialogTitle>
            <DialogDescription>{t("carHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="car-plate" required>
                  {t("plateLabel")}
                </Label>
                <Input
                  id="car-plate"
                  value={plateNumber}
                  onChange={(e) => setPlateNumber(e.target.value)}
                  placeholder={t("platePlaceholder")}
                  maxLength={20}
                  autoCapitalize="characters"
                  required
                  className="h-11 font-mono uppercase"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="car-model" required>
                  {t("modelLabel")}
                </Label>
                <Input id="car-model" value={model} onChange={(e) => setModel(e.target.value)} maxLength={100} required className="h-11" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="car-driver">{t("driverLabel")}</Label>
              <NativeSelect id="car-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)} className="h-11 w-full">
                <option value="">{t("noDriver")}</option>
                {choices.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
              </NativeSelect>
              {drivers && choices.length === 0 ? <p className="text-xs text-muted-foreground">{t("noFreeDriver")}</p> : null}
            </div>
            {car ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="car-status" required>
                  {t("statusLabel")}
                </Label>
                <NativeSelect id="car-status" value={status} onChange={(e) => setStatus(e.target.value as CarStatus)} className="h-11 w-full">
                  {CAR_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`carStatuses.${s}`)}
                    </option>
                  ))}
                </NativeSelect>
                {status === "retired" ? <p className="text-xs text-muted-foreground">{t("retireHint")}</p> : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="car-note">{t("noteLabel")}</Label>
              <textarea id="car-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={TEXTAREA_CLASS} />
            </div>
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
