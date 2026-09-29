"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const TEXTAREA_CLASS =
  "w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

/**
 * Starts a draft: pick the location it's for (and an optional note), then
 * go to its page to add products.
 */
export function NewRequisitionDialog({
  service,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Requisitions");
  const router = useRouter();
  const locations = useQuery(
    api.requisitions.locationOptions,
    open ? { businessUnitKey: service } : "skip",
  );
  const create = useMutation(api.requisitions.create);
  const [locationId, setLocationId] = useState<Id<"locations"> | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Only one location to choose from: pick it.
  const onlyLocation = locations?.length === 1 ? locations[0]._id : null;
  const chosen = locationId || onlyLocation || "";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    setSubmitting(true);
    setError(false);
    try {
      const id = await create({
        businessUnitKey: service,
        locationId: chosen,
        ...(note.trim() ? { note } : {}),
      });
      onOpenChange(false);
      setLocationId("");
      setNote("");
      router.push(`/${service}/requisitions/${id}`);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("newTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="flex flex-col gap-2">
              <Label htmlFor="requisition-location" required>
                {t("locationLabel")}
              </Label>
              <NativeSelect
                id="requisition-location"
                value={chosen}
                onChange={(e) => setLocationId(e.target.value as Id<"locations">)}
                required
              >
                <option value="" disabled>
                  {t("selectLocation")}
                </option>
                {locations?.map((l) => (
                  <option key={l._id} value={l._id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
              {locations?.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noLocations")}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="requisition-note">{t("noteLabel")}</Label>
              <textarea
                id="requisition-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("notePlaceholder")}
                rows={3}
                maxLength={500}
                className={TEXTAREA_CLASS}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{t("saveError")}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || !chosen}>
              {t("createDraft")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
