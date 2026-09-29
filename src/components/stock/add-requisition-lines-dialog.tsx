"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Pick lines of APPROVED requisitions to buy in this batch. Only pending
 * lines that aren't in another batch are offered.
 */
export function AddRequisitionLinesDialog({
  service,
  batchId,
  open,
  onOpenChange,
}: {
  service: BusinessUnitKey;
  batchId: Id<"stockBatches">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("StockBatches");
  const tProducts = useTranslations("Products");
  const options = useQuery(
    api.stockBatches.requisitionOptions,
    open ? { businessUnitKey: service } : "skip",
  );
  const add = useMutation(api.stockBatches.addRequisitionLines);
  const [selected, setSelected] = useState<ReadonlySet<Id<"requisitionItems">>>(new Set());
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (ids: Id<"requisitionItems">[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  async function handleAdd() {
    setSubmitting(true);
    setError(false);
    try {
      await add({ batchId, requisitionItemIds: [...selected] });
      setSelected(new Set());
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
        if (!next) setSelected(new Set());
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("addFromRequisitions")}</DialogTitle>
          <DialogDescription>{t("addFromRequisitionsHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {options === undefined ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noRequisitionLines")}</p>
          ) : (
            options.map((requisition) => {
              const ids = requisition.lines.map((l) => l._id);
              const allOn = ids.every((id) => selected.has(id));
              return (
                <fieldset key={requisition._id} className="rounded-lg border border-border">
                  <legend className="sr-only">{requisition.number}</legend>
                  <label className="flex min-h-11 items-center gap-3 border-b border-border px-3 py-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={allOn}
                      onChange={(e) => toggle(ids, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {requisition.number} · {requisition.locationName ?? "—"}
                      </span>
                      {requisition.note ? (
                        <span className="block truncate text-xs text-muted-foreground">{requisition.note}</span>
                      ) : null}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">{t("allLines")}</span>
                  </label>
                  <ul>
                    {requisition.lines.map((line) => (
                      <li key={line._id}>
                        <label className="flex min-h-11 items-center gap-3 px-3 py-2 pl-8 hover:bg-muted/50">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={selected.has(line._id)}
                            onChange={(e) => toggle([line._id], e.target.checked)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm">{line.productName ?? "—"}</span>
                            <span className="block text-xs text-muted-foreground">
                              {[
                                line.sku,
                                line.lengthInches !== null ? tProducts("inches", { inches: line.lengthInches }) : null,
                                line.colourName,
                                line.note,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                          <span className="text-sm tabular-nums">× {line.qtyRequested}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })
          )}
          {error ? <p className="text-sm text-destructive">{t("actionError")}</p> : null}
        </div>
        <DialogFooter>
          <Button disabled={selected.size === 0 || submitting} onClick={handleAdd}>
            {t("addSelected", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
