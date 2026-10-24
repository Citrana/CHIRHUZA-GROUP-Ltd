"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import type { ProductCategory } from "../../../convex/lib/products";
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
import { cn } from "@/lib/utils";

type HolderKind = "business" | "location" | "user";
type ScopeKind = "all" | "category" | "sample";

function Choice({
  name,
  checked,
  onChange,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm",
        checked ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <input type="radio" name={name} className="size-4 accent-primary" checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}

/**
 * Start a stock count: where (the business's own stock, a shop or warehouse,
 * or a person) and which products (all, one category, or some at random).
 * What the system expects is saved at that moment.
 */
export function NewStockCountDialog({
  service,
  open,
  onOpenChange,
  onStarted,
}: {
  service: BusinessUnitKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (countId: Id<"stockCounts">) => void;
}) {
  const t = useTranslations("StockCounts");
  const tCategory = useTranslations("ProductCategories");
  const options = useQuery(api.stockCounts.options, open ? { businessUnitKey: service } : "skip");
  const start = useMutation(api.stockCounts.start);
  const [holderKind, setHolderKind] = useState<HolderKind>("location");
  const [holderId, setHolderId] = useState("");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("all");
  const [category, setCategory] = useState("");
  const [sampleSize, setSampleSize] = useState("10");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setHolderKind("location");
    setHolderId("");
    setScopeKind("all");
    setCategory("");
    setSampleSize("10");
    setError(null);
  }

  const holderKinds: HolderKind[] = options?.canCountBusiness ? ["location", "user", "business"] : ["location", "user"];
  const holders =
    holderKind === "location"
      ? (options?.locations ?? []).map((l) => ({ id: l._id, label: l.name }))
      : holderKind === "user"
        ? (options?.people ?? []).map((p) => ({ id: p._id, label: p.name }))
        : [];
  const size = Number(sampleSize);
  const ready =
    (holderKind === "business" || holderId !== "") &&
    (scopeKind !== "category" || category !== "") &&
    (scopeKind !== "sample" || (Number.isInteger(size) && size >= 1));

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ready) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const countId = await start({
        businessUnitKey: service,
        holder:
          holderKind === "business"
            ? { type: "business" }
            : holderKind === "location"
              ? { type: "location", id: holderId as Id<"locations"> }
              : { type: "user", id: holderId as Id<"users"> },
        scope:
          scopeKind === "all"
            ? { kind: "all" }
            : scopeKind === "category"
              ? { kind: "category", category: category as ProductCategory }
              : { kind: "sample", size },
      });
      reset();
      onOpenChange(false);
      onStarted(countId);
    } catch (e) {
      const code = e instanceof ConvexError ? (e.data as { code?: string }).code : undefined;
      setError(code === "NOTHING_TO_COUNT" ? t("nothingToCount") : code === "COUNT_OPEN" ? t("countOpen") : t("saveError"));
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
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("startTitle")}</DialogTitle>
            <DialogDescription>{t("startHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5 py-4">
            <RequiredFieldsHint />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                {t("whereLabel")} <span className="text-destructive">*</span>
              </legend>
              <div role="radiogroup" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {holderKinds.map((kind) => (
                  <Choice
                    key={kind}
                    name="count-holder"
                    checked={holderKind === kind}
                    onChange={() => {
                      setHolderKind(kind);
                      setHolderId("");
                    }}
                  >
                    {t(`holderKinds.${kind}`)}
                  </Choice>
                ))}
              </div>
              {holderKind === "business" ? (
                <p className="text-xs text-muted-foreground">{t("businessHint")}</p>
              ) : (
                <NativeSelect
                  aria-label={t("whereLabel")}
                  value={holderId}
                  onChange={(e) => setHolderId(e.target.value)}
                  required
                >
                  <option value="" disabled>
                    {holderKind === "location" ? t("selectLocation") : t("selectPerson")}
                  </option>
                  {holders.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                {t("whatLabel")} <span className="text-destructive">*</span>
              </legend>
              <div role="radiogroup" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(["all", "category", "sample"] as const).map((kind) => (
                  <Choice key={kind} name="count-scope" checked={scopeKind === kind} onChange={() => setScopeKind(kind)}>
                    {t(`scopeKinds.${kind}`)}
                  </Choice>
                ))}
              </div>
              {scopeKind === "category" ? (
                <NativeSelect
                  aria-label={t("categoryLabel")}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  required
                >
                  <option value="" disabled>
                    {t("selectCategory")}
                  </option>
                  {(options?.categories ?? []).map((c) => (
                    <option key={c} value={c}>
                      {tCategory(c)}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
              {scopeKind === "sample" ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="sample-size" required>
                    {t("sampleSizeLabel")}
                  </Label>
                  <Input
                    id="sample-size"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    required
                    value={sampleSize}
                    onChange={(e) => setSampleSize(e.target.value)}
                    className="h-10 w-32 sm:h-8"
                  />
                  <p className="text-xs text-muted-foreground">{t("sampleHint")}</p>
                </div>
              ) : null}
            </fieldset>
            <p className="text-xs text-muted-foreground">{t("blindHint")}</p>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" className="h-11 sm:h-8" disabled={submitting || !ready || options === undefined}>
              {submitting ? t("starting") : t("startSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
