"use client";

import { useState } from "react";
import { MapPin, Building2, User } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

const HOLDER_ICONS = { business: Building2, location: MapPin, user: User } as const;

/** A product's low-stock threshold (products.set_price). */
function ThresholdEditor({ productId, threshold }: { productId: Id<"products">; threshold: number | null }) {
  const t = useTranslations("Inventory.report");
  const setThreshold = useMutation(api.products.setLowStockThreshold);
  const [value, setValue] = useState(threshold === null ? "" : String(threshold));
  const [shown, setShown] = useState(threshold);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  if (threshold !== shown) {
    setShown(threshold);
    setValue(threshold === null ? "" : String(threshold));
  }
  async function save() {
    const next = value.trim() === "" ? null : Number(value);
    if (next !== null && (!Number.isInteger(next) || next < 0)) {
      setError(true);
      return;
    }
    setBusy(true);
    setError(false);
    try {
      await setThreshold({ productId, threshold: next });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const id = `threshold-${productId}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("thresholdLabel")}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value}
          placeholder={t("thresholdPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error || undefined}
          className="h-10 w-28"
        />
        <Button type="button" variant="outline" className="min-h-10" disabled={busy} onClick={save}>
          {t("save")}
        </Button>
      </div>
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ? t("thresholdError") : t("thresholdHint")}
      </p>
    </div>
  );
}

/**
 * Inside an opened report row: where the product is now (per holder), its
 * low-stock threshold, and its movement history (newest first).
 */
export function ProductStockHistory({
  productId,
  threshold,
}: {
  productId: Id<"products">;
  threshold: number | null;
}) {
  const t = useTranslations("Inventory.report");
  const tInventory = useTranslations("Inventory");
  const locale = useLocale();
  const canSetThreshold = useCan("products.set_price");
  const detail = useQuery(api.inventory.productStockDetail, { productId });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
  const holderLabel = (h: { type: string; name: string }) => (h.type === "business" ? tInventory("businessHolder") : h.name);

  if (detail === undefined) return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  if (detail === null) return null;

  return (
    <div className="grid grid-cols-1 gap-4 text-sm lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">{t("whereNow")}</h3>
          {detail.holders.length === 0 ? (
            <p className="text-muted-foreground">{t("noneLeft")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
              {detail.holders.map((h) => {
                const Icon = HOLDER_ICONS[h.type as keyof typeof HOLDER_ICONS] ?? MapPin;
                return (
                  <li key={h.holderId} className="flex min-h-10 items-center justify-between gap-3 px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                      {holderLabel(h)}
                    </span>
                    <span className="font-medium tabular-nums">{h.qty}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {canSetThreshold ? <ThresholdEditor productId={productId} threshold={threshold} /> : null}
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="font-medium">{t("history")}</h3>
        {detail.history.length === 0 ? (
          <p className="text-muted-foreground">{t("noHistory")}</p>
        ) : (
          <ol className="flex max-h-80 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border bg-background">
            {detail.history.map((h) => {
              const sign = h.to && !h.from ? "+" : h.from && !h.to ? "−" : "";
              return (
                <li key={h._id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {t(`movements.${h.type}`)}
                      {h.reference ? <span className="ml-2 font-mono text-xs text-muted-foreground">{h.reference}</span> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {[h.from ? holderLabel(h.from) : null, h.to ? holderLabel(h.to) : null].filter(Boolean).join(" → ")}
                      {" · "}
                      {time.format(h.at)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right tabular-nums">
                    <span className={cn("block font-medium", sign === "−" && "text-destructive")}>
                      {sign}
                      {h.qty}
                    </span>
                    <span className="block text-xs text-muted-foreground">{t("balance", { count: h.balance })}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
