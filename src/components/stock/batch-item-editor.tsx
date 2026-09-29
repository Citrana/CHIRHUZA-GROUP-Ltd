"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export type BatchDetail = NonNullable<FunctionReturnType<typeof api.stockBatches.get>>;
export type BatchItem = BatchDetail["items"][number];

type Patch = Partial<{
  status: "purchased" | "not_purchased";
  qtyPurchased: number;
  unitCost: number | null;
  reason: string;
}>;

/** Saves one field of a line (autosave), keeping the others as they are. */
function useSaveItem(item: BatchItem) {
  const updateItem = useMutation(api.stockBatches.updateItem);
  const [error, setError] = useState(false);
  async function save(patch: Patch) {
    setError(false);
    try {
      await updateItem({
        itemId: item._id,
        status: item.status,
        qtyPurchased: item.qtyPurchased,
        unitCost: item.unitCost ?? null,
        ...(item.reason ? { reason: item.reason } : {}),
        ...patch,
      });
    } catch {
      setError(true);
    }
  }
  return { save, error };
}

/** Product name + details + where the line comes from (requisition or extra). */
export function BatchItemProduct({ item }: { item: BatchItem }) {
  const t = useTranslations("StockBatches");
  const tProducts = useTranslations("Products");
  return (
    <div className="min-w-40">
      <p className="font-medium">{item.productName ?? "—"}</p>
      <p className="text-xs text-muted-foreground">
        {[
          item.sku,
          item.lengthInches !== null ? tProducts("inches", { inches: item.lengthInches }) : null,
          item.colourName,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        {item.requisitionNumber ? (
          <Badge variant="outline">{item.requisitionNumber}</Badge>
        ) : (
          <Badge variant="secondary">{t("extra")}</Badge>
        )}
        {item.productStatus === "pending_confirmation" ? (
          <Badge variant="outline">{tProducts("statuses.pending_confirmation")}</Badge>
        ) : null}
      </div>
    </div>
  );
}

export function ItemStatusField({ item }: { item: BatchItem }) {
  const t = useTranslations("StockBatches");
  const { save } = useSaveItem(item);
  return (
    <NativeSelect
      aria-label={t("lineStatusLabel")}
      className="h-10 min-w-36 sm:h-8"
      value={item.status}
      onChange={(e) => {
        const status = e.target.value as "purchased" | "not_purchased";
        void save({ status, qtyPurchased: status === "purchased" ? item.qtyRequested || 1 : 0 });
      }}
    >
      <option value="purchased">{t("lineStatuses.purchased")}</option>
      <option value="not_purchased">{t("lineStatuses.not_purchased")}</option>
    </NativeSelect>
  );
}

export function ItemQtyField({ item }: { item: BatchItem }) {
  const t = useTranslations("StockBatches");
  const { save, error } = useSaveItem(item);
  const [value, setValue] = useState(String(item.qtyPurchased));
  const [shown, setShown] = useState(item.qtyPurchased);
  if (item.qtyPurchased !== shown) {
    setShown(item.qtyPurchased);
    setValue(String(item.qtyPurchased));
  }
  const commit = () => {
    const qty = Number(value);
    if (qty !== item.qtyPurchased) void save({ qtyPurchased: qty });
  };
  if (item.status === "not_purchased") return <span className="text-muted-foreground">—</span>;
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={1}
      step={1}
      value={value}
      aria-label={t("qtyPurchasedLabel")}
      aria-invalid={error || item.problems.includes("qty") || undefined}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      className="h-10 w-20 sm:h-8"
    />
  );
}

export function ItemCostField({ item, canSetPrice }: { item: BatchItem; canSetPrice: boolean }) {
  const t = useTranslations("StockBatches");
  const { save, error } = useSaveItem(item);
  if (item.status === "not_purchased") return <span className="text-muted-foreground">—</span>;
  return (
    <MoneyInput
      className="w-32"
      currency="USD"
      valueMinor={item.unitCost ?? null}
      onCommit={(unitCost) => void save({ unitCost })}
      disabled={!canSetPrice}
      aria-label={t("unitCostLabel")}
      aria-invalid={error || item.problems.includes("unitCost") || undefined}
    />
  );
}

export function ItemReasonField({ item }: { item: BatchItem }) {
  const t = useTranslations("StockBatches");
  const { save, error } = useSaveItem(item);
  const [value, setValue] = useState(item.reason ?? "");
  const [shown, setShown] = useState(item.reason);
  if (item.reason !== shown) {
    setShown(item.reason);
    setValue(item.reason ?? "");
  }
  const needed = item.problems.includes("reason");
  const commit = () => {
    if (value.trim() !== (item.reason ?? "")) void save({ reason: value });
  };
  return (
    <Input
      value={value}
      placeholder={needed ? t("reasonRequired") : t("reasonOptional")}
      aria-label={t("reasonLabel")}
      aria-invalid={error || needed || undefined}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      maxLength={500}
      className={cn("h-10 min-w-44 sm:h-8", needed && "border-destructive")}
    />
  );
}

export function RemoveItemButton({ item }: { item: BatchItem }) {
  const t = useTranslations("StockBatches");
  const removeItem = useMutation(api.stockBatches.removeItem);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="text-destructive hover:text-destructive"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await removeItem({ itemId: item._id });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Trash2 aria-hidden />
      {t("remove")}
    </Button>
  );
}
