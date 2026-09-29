import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { BusinessUnitKey } from "./businessUnits";
import { logAudit } from "./audit";

/**
 * The product catalogue. Products carry NO prices - prices are set at
 * purchase time. Categories and units are fixed lists (translated in
 * messages/*.json under ProductCategories / ProductUnits); lengths and
 * colours are per-business-unit settings (productLengths / productColours).
 */

export const PRODUCT_CATEGORIES = [
  "wigs",
  "bundles",
  "closures",
  "frontals",
  "extensions",
  "hair_care",
  "accessories",
] as const;

export const productCategoryValidator = v.union(
  v.literal("wigs"),
  v.literal("bundles"),
  v.literal("closures"),
  v.literal("frontals"),
  v.literal("extensions"),
  v.literal("hair_care"),
  v.literal("accessories"),
);
export type ProductCategory = Infer<typeof productCategoryValidator>;

export const PRODUCT_UNITS = ["piece", "bundle", "pack", "set", "bottle"] as const;

export const productUnitValidator = v.union(
  v.literal("piece"),
  v.literal("bundle"),
  v.literal("pack"),
  v.literal("set"),
  v.literal("bottle"),
);
export type ProductUnit = Infer<typeof productUnitValidator>;

export const PRODUCT_STATUSES = [
  "active",
  "pending_confirmation",
  "archived",
] as const;

export const productStatusValidator = v.union(
  v.literal("active"),
  v.literal("pending_confirmation"),
  v.literal("archived"),
);
export type ProductStatus = Infer<typeof productStatusValidator>;

/**
 * How colour names are compared for uniqueness: "1B", " 1b " and "1  B"
 * with collapsed spaces all count as the same colour. Shared by the server
 * check and the settings page's live check so they always agree.
 */
export function normalizeColourName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const SKU_PREFIX: Record<BusinessUnitKey, string> = {
  hair: "HAIR",
  fashion: "FASH",
  housing: "HOUS",
  transport: "TRAN",
};

/**
 * Next SKU for a business unit, e.g. `HAIR-00042`. The per-unit counter is
 * incremented in the caller's transaction, so SKUs are unique and never
 * reused (not even after a product is deleted).
 */
export async function nextSku(
  ctx: MutationCtx,
  unit: Doc<"businessUnits">,
): Promise<string> {
  const counter = await ctx.db
    .query("skuCounters")
    .withIndex("by_businessUnitId", (q) => q.eq("businessUnitId", unit._id))
    .unique();
  const next = counter?.next ?? 1;
  if (counter) {
    await ctx.db.patch("skuCounters", counter._id, { next: next + 1 });
  } else {
    await ctx.db.insert("skuCounters", { businessUnitId: unit._id, next: 2 });
  }
  return `${SKU_PREFIX[unit.key]}-${String(next).padStart(5, "0")}`;
}

/** Lowercased text the search index matches against. */
export function searchTextFor(product: {
  name: string;
  sku: string;
  category: string;
  brand?: string;
  texture?: string;
  lengthInches?: number;
  colourName?: string;
}): string {
  // A length is searchable as "18" and "18in"; the colour by its name.
  const length =
    product.lengthInches !== undefined
      ? `${product.lengthInches} ${product.lengthInches}in`
      : undefined;
  return [
    product.name,
    product.sku,
    product.brand,
    product.texture,
    product.category,
    length,
    product.colourName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

type SearchableProduct = {
  name: string;
  sku: string;
  category: string;
  brand?: string;
  texture?: string;
  lengthInches?: number;
  colourId?: Id<"productColours">;
};

/** searchTextFor, looking up the product's colour name. */
export async function computeSearchText(
  ctx: QueryCtx | MutationCtx,
  product: SearchableProduct,
): Promise<string> {
  const colour = product.colourId
    ? await ctx.db.get("productColours", product.colourId)
    : null;
  return searchTextFor({ ...product, colourName: colour?.name });
}

/**
 * Recomputes a stored product's search text (e.g. after its colour was
 * renamed). Writes only when it changed; returns whether it did.
 */
export async function refreshProductSearchText(
  ctx: MutationCtx,
  product: Doc<"products">,
): Promise<boolean> {
  const searchText = await computeSearchText(ctx, product);
  if (searchText === product.searchText) return false;
  await ctx.db.patch("products", product._id, { searchText });
  return true;
}

/**
 * Whether a product is referenced by a requisition or stock, in which case
 * it can only be archived, never deleted. Checks requisition lines today;
 * TODO: the stock feature must add its check here.
 * Exported as an object property so tests can stub it.
 */
export const productUsage: {
  isProductInUse: (
    ctx: QueryCtx | MutationCtx,
    productId: Id<"products">,
  ) => Promise<boolean>;
} = {
  isProductInUse: async (ctx, productId) => {
    const requisitionLine = await ctx.db
      .query("requisitionItems")
      .withIndex("by_productId", (q) => q.eq("productId", productId))
      .first();
    return requisitionLine !== null;
  },
};

export const PRODUCT_IN_USE =
  "This product is used in stock or requisitions. Archive it instead.";

/**
 * Delete handler for an approved `delete` approval on `products`
 * (registered in DELETE_HANDLERS). Re-checks usage - the product may have
 * been used since the request - then deletes it and audits the removal.
 */
export async function deleteApprovedProduct(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  decider: Doc<"users">,
): Promise<void> {
  const productId = ctx.db.normalizeId("products", approval.entityId);
  const product = productId ? await ctx.db.get("products", productId) : null;
  if (!productId || !product) {
    throw new ConvexError("The product no longer exists.");
  }
  if (await productUsage.isProductInUse(ctx, productId)) {
    throw new ConvexError(PRODUCT_IN_USE);
  }
  await ctx.db.delete("products", productId);
  await logAudit(ctx, {
    actorId: decider._id,
    action: "delete",
    entityTable: "products",
    entityId: productId,
    businessUnitId: product.businessUnitId,
    before: {
      name: product.name,
      sku: product.sku,
      category: product.category,
      unit: product.unit,
      brand: product.brand ?? null,
      texture: product.texture ?? null,
      lengthInches: product.lengthInches ?? null,
      colourId: product.colourId ?? null,
      status: product.status,
    },
    reason: approval.reason,
  });
}
