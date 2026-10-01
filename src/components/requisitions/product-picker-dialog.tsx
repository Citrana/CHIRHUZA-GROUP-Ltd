"use client";

import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { PRODUCT_PROFILES } from "../../../convex/lib/products";
import { DataTableSearch } from "@/components/data-table/data-table-search";
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
import { ProductPhoto } from "@/components/products/product-photo";
import { cn } from "@/lib/utils";

const RESULTS = 20;

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
  const tProducts = useTranslations("Products");
  // Mode products have a photo: show it so the right item is picked.
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"products"> | null>(null);
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const addItem = useMutation(api.requisitions.addItem);
  const results = useQuery(
    api.products.list,
    open
      ? {
          businessUnitKey: service,
          status: "active",
          ...(search.trim() ? { search } : {}),
          paginationOpts: { numItems: RESULTS, cursor: null },
        }
      : "skip",
  );

  function reset() {
    setSearch("");
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
            <DataTableSearch
              value={search}
              onChange={setSearch}
              placeholder={tProducts("searchPlaceholder")}
              className="sm:max-w-none"
            />
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1" role="listbox" aria-label={t("productsLabel")}>
              {results === undefined ? (
                <li className="p-3 text-sm text-muted-foreground">{t("loading")}</li>
              ) : results.page.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">{t("noProducts")}</li>
              ) : (
                results.page.map((p) => {
                  const taken = existingProductIds.has(p._id);
                  const isSelected = selected === p._id;
                  return (
                    <li key={p._id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={taken}
                        onClick={() => setSelected(p._id)}
                        className={cn(
                          "flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                          isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                          taken && "cursor-not-allowed opacity-50 hover:bg-transparent",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          {withPhotos ? <ProductPhoto url={p.photoUrl} /> : null}
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{p.name}</span>
                          <span className={cn("block text-xs", isSelected ? "opacity-80" : "text-muted-foreground")}>
                            {[p.sku, p.lengthInches !== undefined ? tProducts("inches", { inches: p.lengthInches }) : null, p.sizeName, p.colourName]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        </span>
                        {taken ? (
                          <span className="shrink-0 text-xs">{t("alreadyAdded")}</span>
                        ) : isSelected ? (
                          <Check className="size-4 shrink-0" aria-hidden />
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
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
