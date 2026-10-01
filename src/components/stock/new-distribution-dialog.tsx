"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { cn } from "@/lib/utils";

type DestinationType = "location" | "user";

/**
 * Submit a distribution: a destination (a shop/warehouse or a person) and
 * how many units of each lot the business holds. It goes to the Chief
 * Admin for approval; stock moves only once approved.
 */
export function NewDistributionDialog({
  service,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Distributions");
  const tProducts = useTranslations("Products");
  const locale = useLocale();
  const options = useQuery(api.distributions.options, open ? { businessUnitKey: service } : "skip");
  const create = useMutation(api.distributions.create);
  const [toType, setToType] = useState<DestinationType>("location");
  const [toId, setToId] = useState("");
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setToType("location");
    setToId("");
    setSearch("");
    setQty({});
    setNote("");
    setError(null);
  }

  const lines = Object.entries(qty)
    .map(([inventoryBatchId, value]) => ({ inventoryBatchId: inventoryBatchId as Id<"inventoryBatches">, qty: Number(value) }))
    .filter((l) => l.qty > 0);
  const overAsked = options?.lots.some((lot) => Number(qty[lot._id] ?? 0) > lot.available) ?? false;
  const invalidQty = lines.some((l) => !Number.isInteger(l.qty));
  const term = search.trim().toLowerCase();
  const lots = (options?.lots ?? []).filter(
    (lot) =>
      !term ||
      [lot.productName, lot.sku, lot.colourName, lot.sizeName, lot.batchNumber, lot.lengthInches?.toString()]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(term)),
  );

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!toId || lines.length === 0) {
      setError(t("missingFields"));
      return;
    }
    if (overAsked || invalidQty) {
      setError(t("fixQuantities"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await create({
        businessUnitKey: service,
        to:
          toType === "location"
            ? { type: "location", id: toId as Id<"locations"> }
            : { type: "user", id: toId as Id<"users"> },
        lines,
        ...(note.trim() ? { note } : {}),
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; available?: number }) : null;
      setError(
        data?.code === "INSUFFICIENT_STOCK" ? t("notEnough", { available: data.available ?? 0 }) : t("saveError"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const destinations =
    toType === "location"
      ? (options?.locations ?? []).map((l) => ({ id: l._id, label: l.name }))
      : (options?.people ?? []).map((p) => ({ id: p._id, label: `${p.name} (${p.email})` }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("newTitle")}</DialogTitle>
            <DialogDescription>{t("newHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                {t("destinationLabel")} <span className="text-destructive">*</span>
              </legend>
              <div role="radiogroup" className="grid grid-cols-2 gap-2">
                {(["location", "user"] as const).map((type) => (
                  <label
                    key={type}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
                      toType === type ? "border-primary bg-primary/5" : "border-border",
                    )}
                  >
                    <input
                      type="radio"
                      name="destination-type"
                      className="size-4 accent-primary"
                      checked={toType === type}
                      onChange={() => {
                        setToType(type);
                        setToId("");
                      }}
                    />
                    {t(`destinationTypes.${type}`)}
                  </label>
                ))}
              </div>
              <NativeSelect
                aria-label={t("destinationLabel")}
                value={toId}
                onChange={(e) => setToId(e.target.value)}
                required
              >
                <option value="" disabled>
                  {toType === "location" ? t("selectLocation") : t("selectPerson")}
                </option>
                {destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </NativeSelect>
            </fieldset>

            <div className="flex flex-col gap-2">
              <Label required>{t("linesLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("linesHint")}</p>
              <DataTableSearch
                value={search}
                onChange={setSearch}
                placeholder={t("searchPlaceholder")}
                className="sm:max-w-none"
              />
              <ul className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
                {options === undefined ? (
                  <li className="p-3 text-sm text-muted-foreground">{t("loading")}</li>
                ) : lots.length === 0 ? (
                  <li className="p-3 text-sm text-muted-foreground">{t("noStock")}</li>
                ) : (
                  lots.map((lot) => {
                    const value = qty[lot._id] ?? "";
                    const tooMany = Number(value) > lot.available;
                    return (
                      <li key={lot._id} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{lot.productName ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            {[
                              lot.sku,
                              lot.lengthInches !== null ? tProducts("inches", { inches: lot.lengthInches }) : null, lot.sizeName,
                              lot.colourName,
                              lot.batchNumber,
                              formatMoney(lot.unitCost, "USD", locale),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          <p className={cn("text-xs", tooMany ? "text-destructive" : "text-muted-foreground")}>
                            {t("available", { available: lot.available, onHand: lot.onHand })}
                          </p>
                        </div>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={lot.available}
                          step={1}
                          value={value}
                          placeholder="0"
                          disabled={lot.available === 0}
                          aria-label={t("qtyFor", { product: lot.productName ?? "—" })}
                          aria-invalid={tooMany || undefined}
                          onChange={(e) => setQty((prev) => ({ ...prev, [lot._id]: e.target.value }))}
                          className="h-10 w-20 shrink-0 sm:h-8"
                        />
                      </li>
                    );
                  })
                )}
              </ul>
              {lines.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("selectedSummary", { lines: lines.length, units: lines.reduce((s, l) => s + l.qty, 0) })}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="distribution-note">{t("noteLabel")}</Label>
              <textarea
                id="distribution-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={500}
                className={TEXTAREA_CLASS}
              />
            </div>
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || lines.length === 0 || !toId || overAsked}>
              {submitting ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
