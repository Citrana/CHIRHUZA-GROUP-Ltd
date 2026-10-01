"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import {
  PRODUCT_PROFILES,
  type ProductCategory,
  type ProductUnit,
} from "../../../convex/lib/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/lib/use-can";

type Form = {
  name: string;
  category: ProductCategory | "";
  unit: ProductUnit | "";
  brand: string;
  texture: string;
  lengthInches: string;
  sizeId: Id<"productSizes"> | "";
  colourId: Id<"productColours"> | "";
};

function formFrom(product?: Doc<"products">): Form {
  return {
    name: product?.name ?? "",
    category: product?.category ?? "",
    unit: product?.unit ?? "",
    brand: product?.brand ?? "",
    texture: product?.texture ?? "",
    lengthInches: product?.lengthInches?.toString() ?? "",
    sizeId: product?.sizeId ?? "",
    colourId: product?.colourId ?? "",
  };
}

/**
 * Create (no `product`) or edit a product. Lengths and colours come from
 * the service's product settings; the product's current value stays
 * selectable even if it has since been deactivated. Purchase prices live on
 * stock lots; products.set_price holders also see the optional suggested
 * selling price (saved through products.setSuggestedPrice).
 */
export function ProductFormDialog({
  service,
  product,
  open,
  onOpenChange,
  onCreated,
}: {
  service: BusinessUnitKey;
  product?: Doc<"products">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new product's id after a successful create. */
  onCreated?: (productId: Id<"products">) => void;
}) {
  const t = useTranslations("Products");
  const tCategories = useTranslations("ProductCategories");
  const tUnits = useTranslations("ProductUnits");
  const canConfirm = useCan("products.confirm");
  const canSetPrice = useCan("products.set_price");
  // What this service's products look like (categories, units, attributes).
  const profile = PRODUCT_PROFILES[service];
  const lengths = useQuery(
    api.productOptions.listLengths,
    open && profile.attributes.length ? { businessUnitKey: service, includeInactive: true } : "skip",
  );
  const sizes = useQuery(
    api.productOptions.listSizes,
    open && profile.attributes.size ? { businessUnitKey: service, includeInactive: true } : "skip",
  );
  const colours = useQuery(
    api.productOptions.listColours,
    open ? { businessUnitKey: service, includeInactive: true } : "skip",
  );
  const create = useMutation(api.products.create);
  const update = useMutation(api.products.update);
  const setSuggestedPrice = useMutation(api.products.setSuggestedPrice);

  const [form, setForm] = useState<Form>(() => formFrom(product));
  const [price, setPrice] = useState<number | null>(product?.suggestedPrice ?? null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reload the form each time the dialog opens (for this product).
  const openKey = open ? (product?._id ?? "new") : null;
  if (openKey !== loadedFor) {
    setLoadedFor(openKey);
    if (openKey) {
      setForm(formFrom(product));
      setPrice(product?.suggestedPrice ?? null);
      setError(false);
    }
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Active options, plus the product's own value if it was deactivated.
  const lengthOptions = (lengths ?? []).filter(
    (l) => l.active || l.inches === product?.lengthInches,
  );
  const colourOptions = (colours ?? []).filter(
    (c) => c.active || c._id === product?.colourId,
  );
  const sizeOptions = (sizes ?? []).filter((z) => z.active || z._id === product?.sizeId);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form.category || !form.unit) return;
    setSubmitting(true);
    setError(false);
    const fields = {
      name: form.name,
      category: form.category,
      unit: form.unit,
      ...(form.brand.trim() ? { brand: form.brand } : {}),
      ...(profile.attributes.texture && form.texture.trim() ? { texture: form.texture } : {}),
      ...(profile.attributes.length && form.lengthInches ? { lengthInches: Number(form.lengthInches) } : {}),
      ...(profile.attributes.size && form.sizeId ? { sizeId: form.sizeId } : {}),
      ...(form.colourId ? { colourId: form.colourId } : {}),
    };
    try {
      let productId: Id<"products">;
      if (product) {
        productId = product._id;
        await update({ productId, ...fields });
      } else {
        productId = await create({ businessUnitKey: service, ...fields });
        onCreated?.(productId);
      }
      if (canSetPrice && price !== (product?.suggestedPrice ?? null)) {
        await setSuggestedPrice({ productId, price });
      }
      onOpenChange(false);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{product ? t("editTitle") : t("createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            {product ? (
              <p className="text-sm text-muted-foreground">
                {t("skuLabel")}: <span className="font-mono">{product.sku}</span>
              </p>
            ) : canConfirm === false ? (
              <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                {t("needsConfirmationHint")}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="product-name" required>{t("nameLabel")}</Label>
              <Input
                id="product-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                maxLength={120}
                required
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-category" required>{t("categoryLabel")}</Label>
                <NativeSelect
                  id="product-category"
                  value={form.category}
                  onChange={(e) => set("category", e.target.value as ProductCategory)}
                  required
                >
                  <option value="" disabled>
                    {t("selectCategory")}
                  </option>
                  {profile.categories.map((c) => (
                    <option key={c} value={c}>
                      {tCategories(c)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-unit" required>{t("unitLabel")}</Label>
                <NativeSelect
                  id="product-unit"
                  value={form.unit}
                  onChange={(e) => set("unit", e.target.value as ProductUnit)}
                  required
                >
                  <option value="" disabled>
                    {t("selectUnit")}
                  </option>
                  {profile.units.map((u) => (
                    <option key={u} value={u}>
                      {tUnits(u)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {profile.attributes.length ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="product-length">{t("lengthLabel")}</Label>
                  <NativeSelect
                    id="product-length"
                    value={form.lengthInches}
                    onChange={(e) => set("lengthInches", e.target.value)}
                  >
                    <option value="">{t("none")}</option>
                    {lengthOptions.map((l) => (
                      <option key={l._id} value={l.inches}>
                        {t("inches", { inches: l.inches })}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              {profile.attributes.size ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="product-size">{t("sizeLabel")}</Label>
                  <NativeSelect
                    id="product-size"
                    value={form.sizeId}
                    onChange={(e) => set("sizeId", e.target.value as Id<"productSizes"> | "")}
                  >
                    <option value="">{t("none")}</option>
                    {sizeOptions.map((z) => (
                      <option key={z._id} value={z._id}>
                        {z.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-colour">{t("colourLabel")}</Label>
                <NativeSelect
                  id="product-colour"
                  value={form.colourId}
                  onChange={(e) => set("colourId", e.target.value as Id<"productColours"> | "")}
                >
                  <option value="">{t("none")}</option>
                  {colourOptions.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-brand">{t("brandLabel")}</Label>
                <Input
                  id="product-brand"
                  value={form.brand}
                  onChange={(e) => set("brand", e.target.value)}
                  maxLength={60}
                />
              </div>
              {profile.attributes.texture ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="product-texture">{t("textureLabel")}</Label>
                  <Input
                    id="product-texture"
                    value={form.texture}
                    onChange={(e) => set("texture", e.target.value)}
                    placeholder={t("texturePlaceholder")}
                    maxLength={60}
                  />
                </div>
              ) : null}
            </div>
            {canSetPrice ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="product-price">{t("suggestedPriceLabel")}</Label>
                <MoneyInput id="product-price" currency="USD" valueMinor={price} onCommit={setPrice} className="sm:max-w-48" />
                <p className="text-xs text-muted-foreground">{t("suggestedPriceHint")}</p>
              </div>
            ) : null}
            {(profile.attributes.length && lengths?.length === 0) ||
            (profile.attributes.size && sizes?.length === 0) ||
            colours?.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {profile.attributes.size ? t("noSettingsHintSizes") : t("noSettingsHint")}
              </p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{t("saveError")}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
