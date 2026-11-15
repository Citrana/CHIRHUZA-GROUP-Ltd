"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { PRODUCT_PROFILES, type ProductStatus } from "../../../convex/lib/products";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { ProductPhoto } from "@/components/products/product-photo";
import { cn } from "@/lib/utils";

const RESULTS = 20;

export type ProductSearchResult = FunctionReturnType<typeof api.products.list>["page"][number];

/**
 * Search a service's products (server search, products.view) and pick one:
 * name, SKU, length / size / colour, and the photo for Mode. Shared by the
 * requisition product picker and Check sales. Products in `disabledIds`
 * are shown but can't be picked (with `disabledLabel`).
 */
export function ProductSearchList({
  service,
  active,
  status,
  selectedId,
  onSelect,
  disabledIds,
  disabledLabel,
  emptyLabel,
  label,
}: {
  service: BusinessUnitKey;
  /** Skip the query while hidden (e.g. a closed dialog). */
  active: boolean;
  /** Only products with this status; omitted = every status. */
  status?: ProductStatus;
  selectedId: Id<"products"> | null;
  onSelect: (product: ProductSearchResult) => void;
  disabledIds?: ReadonlySet<string>;
  disabledLabel?: string;
  /** Shown when nothing matches (default: no active product matches). */
  emptyLabel?: string;
  label: string;
}) {
  const t = useTranslations("Requisitions");
  const tProducts = useTranslations("Products");
  // Mode products have a photo: show it so the right item is picked.
  const withPhotos = PRODUCT_PROFILES[service].attributes.photo;
  const [search, setSearch] = useState("");
  const results = useQuery(
    api.products.list,
    active
      ? {
          businessUnitKey: service,
          ...(status ? { status } : {}),
          ...(search.trim() ? { search } : {}),
          paginationOpts: { numItems: RESULTS, cursor: null },
        }
      : "skip",
  );

  return (
    <div className="flex flex-col gap-3">
      <DataTableSearch
        value={search}
        onChange={setSearch}
        placeholder={tProducts("searchPlaceholder")}
        className="sm:max-w-none"
      />
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1" role="listbox" aria-label={label}>
        {results === undefined ? (
          <li className="p-3 text-sm text-muted-foreground">{t("loading")}</li>
        ) : results.page.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">{emptyLabel ?? t("noProducts")}</li>
        ) : (
          results.page.map((p) => {
            const taken = disabledIds?.has(p._id) ?? false;
            const isSelected = selectedId === p._id;
            return (
              <li key={p._id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={taken}
                  onClick={() => onSelect(p)}
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
                    <span className="shrink-0 text-xs">{disabledLabel}</span>
                  ) : isSelected ? (
                    <Check className="size-4 shrink-0" aria-hidden />
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
