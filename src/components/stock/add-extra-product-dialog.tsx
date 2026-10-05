"use client";

import { useState, type FormEvent } from "react";
import { Check, Plus } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { PRODUCT_PROFILES } from "../../../convex/lib/products";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductFormDialog } from "@/components/products/product-form-dialog";
import { ProductPhoto } from "@/components/products/product-photo";
import { cn } from "@/lib/utils";

/**
 * Add a product that wasn't requested ("extra"): pick an active or pending
 * product, or create a new one on the spot (it starts pending confirmation
 * for the buyer).
 */
export function AddExtraProductDialog({
  service,
  batchId,
  canSetPrice,
  requisitionId = null,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  batchId: Id<"stockBatches">;
  canSetPrice: boolean;
  /** Pre-selects the requisition the products are for (e.g. an empty one). */
  requisitionId?: Id<"requisitions"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("StockBatches");
  const tProducts = useTranslations("Products");
  // Mode products have a photo: show it so the right item is picked.
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"products"> | null>(null);
  const [qty, setQty] = useState("1");
  const [unitCost, setUnitCost] = useState<number | null>(null);
  const [newProductOpen, setNewProductOpen] = useState(false);
  // "" = an extra purchase; otherwise the requisition it's for.
  const [forRequisition, setForRequisition] = useState<string>(requisitionId ?? "");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const openKey = open ? (requisitionId ?? "") : null;
  if (openKey !== loadedFor) {
    setLoadedFor(openKey);
    if (openKey !== null) setForRequisition(openKey);
  }
  const targets = useQuery(api.stockBatches.targetRequisitions, open ? { businessUnitKey: service } : "skip");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const addExtra = useMutation(api.stockBatches.addExtraItem);
  const results = useQuery(
    api.products.list,
    open
      ? {
          businessUnitKey: service,
          ...(search.trim() ? { search } : {}),
          paginationOpts: { numItems: 20, cursor: null },
        }
      : "skip",
  );
  const products = results?.page.filter((p) => p.status !== "archived");

  function reset() {
    setSearch("");
    setSelected(null);
    setQty("1");
    setUnitCost(null);
    setError(false);
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError(false);
    try {
      await addExtra({
        batchId,
        productId: selected,
        qtyPurchased: Number(qty),
        ...(unitCost !== null ? { unitCost } : {}),
        ...(forRequisition ? { requisitionId: forRequisition as Id<"requisitions"> } : {}),
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
    <>
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
              <DialogTitle>{t("addExtra")}</DialogTitle>
              <DialogDescription>{t("addExtraHint")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 py-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="extra-requisition">{t("forRequisitionLabel")}</Label>
                <NativeSelect
                  id="extra-requisition"
                  value={forRequisition}
                  onChange={(e) => setForRequisition(e.target.value)}
                >
                  <option value="">{t("noRequisition")}</option>
                  {(targets ?? []).map((r) => (
                    <option key={r._id} value={r._id}>
                      {[r.number, r.locationName, r.lineCount === 0 ? t("emptyRequisition") : null, r.note]
                        .filter(Boolean)
                        .join(" · ")}
                    </option>
                  ))}
                </NativeSelect>
                {forRequisition ? <p className="text-xs text-muted-foreground">{t("forRequisitionHint")}</p> : null}
              </div>
              <div className="flex gap-2">
                <DataTableSearch
                  value={search}
                  onChange={setSearch}
                  placeholder={tProducts("searchPlaceholder")}
                  className="sm:max-w-none"
                />
                <Button type="button" variant="outline" className="h-10 shrink-0 sm:h-8" onClick={() => setNewProductOpen(true)}>
                  <Plus aria-hidden />
                  {t("newProduct")}
                </Button>
              </div>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1" role="listbox" aria-label={t("productsLabel")}>
                {products === undefined ? (
                  <li className="p-3 text-sm text-muted-foreground">{t("loading")}</li>
                ) : products.length === 0 ? (
                  <li className="p-3 text-sm text-muted-foreground">{t("noProducts")}</li>
                ) : (
                  products.map((p) => {
                    const isSelected = selected === p._id;
                    return (
                      <li key={p._id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => setSelected(p._id)}
                          className={cn(
                            "flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                            isSelected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
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
                          {p.status === "pending_confirmation" ? (
                            <Badge variant="outline" className="shrink-0">{tProducts("statuses.pending_confirmation")}</Badge>
                          ) : isSelected ? (
                            <Check className="size-4 shrink-0" aria-hidden />
                          ) : null}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="extra-qty" required>
                    {t("qtyPurchasedLabel")}
                  </Label>
                  <Input
                    id="extra-qty"
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
                  <Label htmlFor="extra-cost">{t("unitCostLabel")}</Label>
                  <MoneyInput
                    id="extra-cost"
                    currency="USD"
                    valueMinor={unitCost}
                    onCommit={setUnitCost}
                    disabled={!canSetPrice}
                  />
                </div>
              </div>
              {error ? <p className="text-sm text-destructive">{t("actionError")}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!selected || submitting}>
                {t("addToBatch")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ProductFormDialog
        service={service}
        open={newProductOpen}
        onOpenChange={setNewProductOpen}
        onCreated={(productId) => {
          setSelected(productId);
          setSearch("");
        }}
      />
    </>
  );
}
