"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductSearchList } from "@/components/products/product-search-list";

/**
 * Pick an active product of the service (server search) and a quantity,
 * then add it as a requisition line. Products already on the requisition
 * are shown but can't be picked again.
 */
export function ProductPickerDialog({
  service,
  requisitionId,
  existingProductIds,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  requisitionId: Id<"requisitions">;
  existingProductIds: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Requisitions");
  // A new key clears the search when the picker is reset.
  const [listKey, setListKey] = useState(0);
  const [selected, setSelected] = useState<Id<"products"> | null>(null);
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const addItem = useMutation(api.requisitions.addItem);

  function reset() {
    setListKey((k) => k + 1);
    setSelected(null);
    setQty("1");
    setNote("");
    setError(false);
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError(false);
    try {
      await addItem({
        requisitionId,
        productId: selected,
        qtyRequested: Number(qty),
        ...(note.trim() ? { note } : {}),
      });
      reset();
      onOpenChange(false);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleAdd}>
          <DialogHeader>
            <DialogTitle>{t("addProductTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <ProductSearchList
              key={listKey}
              service={service}
              active={open}
              status="active"
              selectedId={selected}
              onSelect={(p) => setSelected(p._id)}
              disabledIds={existingProductIds}
              disabledLabel={t("alreadyAdded")}
              label={t("productsLabel")}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
              <div className="flex flex-col gap-2">
                <Label htmlFor="picker-qty" required>
                  {t("qtyLabel")}
                </Label>
                <Input
                  id="picker-qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="h-10 sm:h-8"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="picker-note">{t("lineNoteLabel")}</Label>
                <Input
                  id="picker-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("lineNotePlaceholder")}
                  maxLength={500}
                  className="h-10 sm:h-8"
                />
              </div>
            </div>
            {error ? <p className="text-sm text-destructive">{t("addError")}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!selected || submitting}>
              {t("addToRequisition")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
