import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/rbac";
import { diff } from "./lib/audit";
import { requestApproval } from "./lib/approvals";
import {
  businessUnitKeyValidator,
  requireBusinessUnit,
} from "./lib/businessUnits";
import {
  nextSku,
  PRODUCT_IN_USE,
  PRODUCT_PROFILES,
  photoProblem,
  productDetails,
  productCategoryValidator,
  productStatusValidator,
  productUnitValidator,
  productUsage,
  computeSearchText,
  refreshProductSearchText,
} from "./lib/products";
import { refreshProductStockStatus } from "./lib/inventory";

/**
 * The product catalogue. Purchase prices live on stock lots; a product may
 * carry an optional suggested selling price (products.set_price), which
 * the sale form pre-fills. Every change is audited; deletes go through
 * the approval engine.
 */

const editableFields = {
  name: v.string(),
  category: productCategoryValidator,
  unit: productUnitValidator,
  brand: v.optional(v.string()),
  texture: v.optional(v.string()),
  lengthInches: v.optional(v.number()),
  sizeId: v.optional(v.id("productSizes")),
  colourId: v.optional(v.id("productColours")),
};

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new ConvexError("Product name is required.");
  if (trimmed.length > 120) throw new ConvexError("Product name is too long.");
  return trimmed;
}

function cleanOptional(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  if (trimmed.length > 60) throw new ConvexError(`${label} is too long.`);
  return trimmed;
}

/**
 * The chosen length/colour must be active settings of the product's
 * business unit. A value the product already has stays allowed even after
 * it's deactivated.
 */
async function assertValidOptions(
  ctx: QueryCtx,
  unit: Doc<"businessUnits">,
  next: {
    category: string;
    unit: string;
    texture?: string;
    lengthInches?: number;
    sizeId?: Id<"productSizes">;
    colourId?: Id<"productColours">;
  },
  current?: Doc<"products">,
) {
  const businessUnitId = unit._id;
  // What this service's products look like (PRODUCT_PROFILES).
  const profile = PRODUCT_PROFILES[unit.key];
  if (!(profile.categories as readonly string[]).includes(next.category)) {
    throw new ConvexError("This category isn't used by this service.");
  }
  if (!(profile.units as readonly string[]).includes(next.unit)) {
    throw new ConvexError("This unit isn't used by this service.");
  }
  if (next.lengthInches !== undefined && !profile.attributes.length) {
    throw new ConvexError("Products of this service have no length.");
  }
  if (next.sizeId !== undefined && !profile.attributes.size) {
    throw new ConvexError("Products of this service have no size.");
  }
  if (next.texture?.trim() && !profile.attributes.texture) {
    throw new ConvexError("Products of this service have no texture.");
  }
  if (next.sizeId !== undefined && next.sizeId !== current?.sizeId) {
    const size = await ctx.db.get("productSizes", next.sizeId);
    if (!size || !size.active || size.businessUnitId !== businessUnitId) {
      throw new ConvexError("Choose a size from the product settings.");
    }
  }
  if (next.lengthInches !== undefined && next.lengthInches !== current?.lengthInches) {
    const length = await ctx.db
      .query("productLengths")
      .withIndex("by_businessUnitId_and_inches", (q) =>
        q.eq("businessUnitId", businessUnitId).eq("inches", next.lengthInches!),
      )
      .unique();
    if (!length || !length.active) {
      throw new ConvexError("Choose a length from the product settings.");
    }
  }
  if (next.colourId !== undefined && next.colourId !== current?.colourId) {
    const colour = await ctx.db.get("productColours", next.colourId);
    if (!colour || !colour.active || colour.businessUnitId !== businessUnitId) {
      throw new ConvexError("Choose a colour from the product settings.");
    }
  }
}

/** Readable snapshot for audit entries and deletion approvals. */
async function describe(ctx: QueryCtx, product: Omit<Doc<"products">, "_id" | "_creationTime">) {
  const colour = product.colourId ? await ctx.db.get("productColours", product.colourId) : null;
  const size = product.sizeId ? await ctx.db.get("productSizes", product.sizeId) : null;
  return {
    name: product.name,
    sku: product.sku,
    category: product.category,
    unit: product.unit,
    brand: product.brand ?? null,
    texture: product.texture ?? null,
    lengthInches: product.lengthInches ?? null,
    size: size?.name ?? null,
    colour: colour?.name ?? null,
    status: product.status,
  };
}

async function pendingDeletionFor(ctx: QueryCtx, productId: Id<"products">) {
  const approval = await ctx.db
    .query("approvals")
    .withIndex("by_entityTable_and_entityId", (q) =>
      q.eq("entityTable", "products").eq("entityId", productId),
    )
    .filter((q) =>
      q.and(q.eq(q.field("type"), "delete"), q.eq(q.field("status"), "pending")),
    )
    .first();
  return approval?._id ?? null;
}

async function requireProduct(ctx: MutationCtx, productId: Id<"products">) {
  const product = await ctx.db.get("products", productId);
  if (!product) throw new ConvexError("Product not found.");
  return product;
}

/**
 * Products of one service, by name. `search` matches name, SKU, brand,
 * texture and category; `category` / `status` filter.
 */
export const list = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    category: v.optional(productCategoryValidator),
    status: v.optional(productStatusValidator),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("products.view");
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const { category, status } = args;
    const term = args.search?.trim().toLowerCase();
    const table = ctx.db.query("products");

    const result = term
      ? await table
          .withSearchIndex("search_text", (q) => {
            let search = q.search("searchText", term).eq("businessUnitId", unit._id);
            if (status) search = search.eq("status", status);
            if (category) search = search.eq("category", category);
            return search;
          })
          .paginate(args.paginationOpts)
      : status
        ? await table
            .withIndex("by_businessUnitId_and_status_and_name", (q) =>
              q.eq("businessUnitId", unit._id).eq("status", status),
            )
            .filter((q) => (category ? q.eq(q.field("category"), category) : true))
            .paginate(args.paginationOpts)
        : category
          ? await table
              .withIndex("by_businessUnitId_and_category_and_name", (q) =>
                q.eq("businessUnitId", unit._id).eq("category", category),
              )
              .paginate(args.paginationOpts)
          : await table
              .withIndex("by_businessUnitId_and_name", (q) =>
                q.eq("businessUnitId", unit._id),
              )
              .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (product) => {
          const { colourName, sizeName } = await productDetails(ctx, product);
          return {
            ...product,
            colourName,
            sizeName,
            photoUrl: product.photoFileId ? await ctx.storage.getUrl(product.photoFileId) : null,
            pendingDeletion: (await pendingDeletionFor(ctx, product._id)) !== null,
          };
        }),
      ),
    };
  },
});

/**
 * The price list: for each product, its suggested selling price, what each
 * of its lots was bought at, what's on hand, and the last price it actually
 * sold at. For anyone with stock or sales access (purchase costs included);
 * products.set_price holders may change the selling price from here.
 */
export const priceList = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("products.view");
    if (!ctx.can("stock.view") && !ctx.can("sales.view") && !ctx.can("sales.create")) {
      throw new ConvexError("Forbidden: the price list needs stock or sales access.");
    }
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    const term = args.search?.trim().toLowerCase();
    const result = term
      ? await ctx.db
          .query("products")
          .withSearchIndex("search_text", (q) => q.search("searchText", term).eq("businessUnitId", unit._id))
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("products")
          .withIndex("by_businessUnitId_and_name", (q) => q.eq("businessUnitId", unit._id))
          .paginate(args.paginationOpts);
    const page = await Promise.all(
      result.page
        .filter((product) => product.status !== "archived")
        .map(async (product) => {
          const details = await productDetails(ctx, product);
          const suggested = product.suggestedPrice ?? null;
          const rawLots = await ctx.db
            .query("inventoryBatches")
            .withIndex("by_productId", (q) => q.eq("productId", product._id))
            .take(200);
          const lots = await Promise.all(
            rawLots.map(async (lot) => {
              const [batch, levels] = await Promise.all([
                ctx.db.get("stockBatches", lot.stockBatchId),
                ctx.db
                  .query("stockLevels")
                  .withIndex("by_inventoryBatchId_and_holderId", (q) => q.eq("inventoryBatchId", lot._id))
                  .take(500),
              ]);
              return {
                _id: lot._id,
                batchNumber: batch?.number ?? null,
                purchasedAt: lot.createdAt,
                unitCost: lot.unitCost,
                receivedQty: lot.receivedQty,
                onHand: levels.reduce((s, l) => s + l.qtyOnHand, 0),
                marginAtSuggested: suggested === null ? null : suggested - lot.unitCost,
              };
            }),
          );
          lots.sort((a, b) => b.purchasedAt - a.purchasedAt);
          const costs = lots.map((l) => l.unitCost);
          const lastItem = await ctx.db
            .query("saleItems")
            .withIndex("by_productId", (q) => q.eq("productId", product._id))
            .order("desc")
            .first();
          const lastSale = lastItem ? await ctx.db.get("sales", lastItem.saleId) : null;
          return {
            _id: product._id,
            name: product.name,
            sku: product.sku,
            status: product.status,
            ...details,
            suggestedPrice: suggested,
            lots,
            onHand: lots.reduce((s, l) => s + l.onHand, 0),
            minCost: costs.length ? Math.min(...costs) : null,
            maxCost: costs.length ? Math.max(...costs) : null,
            lastSold: lastItem && lastSale ? { unitPrice: lastItem.unitPrice, soldAt: lastSale.createdAt } : null,
          };
        }),
    );
    return { ...result, page };
  },
});

/** One product for the detail drawer, with what this user may do to it. */
export const get = authedQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    await ctx.requirePermission("products.view");
    const product = await ctx.db.get("products", productId);
    if (!product) return null;
    const { colourName, sizeName } = await productDetails(ctx, product);
    const creator = await ctx.db.get("users", product.createdBy);
    const confirmer = product.confirmedBy ? await ctx.db.get("users", product.confirmedBy) : null;
    return {
      ...product,
      colourName,
      sizeName,
      photoUrl: product.photoFileId ? await ctx.storage.getUrl(product.photoFileId) : null,
      createdByName: creator?.name || creator?.email || null,
      confirmedByName: confirmer?.name || confirmer?.email || null,
      pendingDeletionApprovalId: await pendingDeletionFor(ctx, productId),
      inUse: await productUsage.isProductInUse(ctx, productId),
      canManage: ctx.can("products.manage"),
      canConfirm:
        product.status === "pending_confirmation" &&
        ctx.can("products.confirm") &&
        (product.createdBy !== ctx.user._id || ctx.isSuperAdmin),
    };
  },
});

/**
 * Creates a product with an auto-generated SKU. Users who can confirm
 * products create them active; everyone else creates them pending
 * confirmation (e.g. the Chief Inventory Admin while purchasing).
 */
export const create = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, ...editableFields },
  handler: async (ctx, { businessUnitKey, ...args }) => {
    await ctx.requirePermission("products.manage");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const name = cleanName(args.name);
    const brand = cleanOptional(args.brand, "Brand");
    const texture = cleanOptional(args.texture, "Texture");
    await assertValidOptions(ctx, unit, args);

    const confirmed = ctx.can("products.confirm");
    const sku = await nextSku(ctx, unit);
    const product = {
      businessUnitId: unit._id,
      name,
      sku,
      category: args.category,
      unit: args.unit,
      ...(brand ? { brand } : {}),
      ...(texture ? { texture } : {}),
      ...(args.lengthInches !== undefined ? { lengthInches: args.lengthInches } : {}),
      ...(args.sizeId ? { sizeId: args.sizeId } : {}),
      ...(args.colourId ? { colourId: args.colourId } : {}),
      status: confirmed ? ("active" as const) : ("pending_confirmation" as const),
      createdBy: ctx.user._id,
      ...(confirmed ? { confirmedBy: ctx.user._id, confirmedAt: Date.now() } : {}),
      searchText: await computeSearchText(ctx, {
        name,
        sku,
        category: args.category,
        brand,
        texture,
        lengthInches: args.lengthInches,
        sizeId: args.sizeId,
        colourId: args.colourId,
      }),
    };
    const productId = await ctx.db.insert("products", product);
    await ctx.audit({
      action: "create",
      entityTable: "products",
      entityId: productId,
      businessUnitId: unit._id,
      after: await describe(ctx, product),
    });
    return productId;
  },
});

/** Edits a product's details. The SKU and status never change here. */
export const update = authedMutation({
  args: { productId: v.id("products"), ...editableFields },
  handler: async (ctx, { productId, ...args }) => {
    await ctx.requirePermission("products.manage");
    const product = await requireProduct(ctx, productId);
    const name = cleanName(args.name);
    const brand = cleanOptional(args.brand, "Brand");
    const texture = cleanOptional(args.texture, "Texture");
    const unit = (await ctx.db.get("businessUnits", product.businessUnitId))!;
    await assertValidOptions(ctx, unit, args, product);

    const next = {
      ...product,
      name,
      category: args.category,
      unit: args.unit,
      brand,
      texture,
      lengthInches: args.lengthInches,
      sizeId: args.sizeId,
      colourId: args.colourId,
    };
    const changes = diff(await describe(ctx, product), await describe(ctx, next));
    if (!changes) return;
    // `undefined` removes an optional field that was cleared.
    await ctx.db.patch("products", productId, {
      name,
      category: args.category,
      unit: args.unit,
      brand,
      texture,
      lengthInches: args.lengthInches,
      sizeId: args.sizeId,
      colourId: args.colourId,
      searchText: await computeSearchText(ctx, {
        name,
        sku: product.sku,
        category: args.category,
        brand,
        texture,
        lengthInches: args.lengthInches,
        sizeId: args.sizeId,
        colourId: args.colourId,
      }),
    });
    await ctx.audit({
      action: "update",
      entityTable: "products",
      entityId: productId,
      businessUnitId: product.businessUnitId,
      ...changes,
    });
  },
});

/**
 * Sets (or, with null, clears) the product's low-stock threshold: the
 * stock report marks it "low" when units on hand fall to it or below.
 * products.set_price - the people who manage selling prices.
 */
export const setLowStockThreshold = authedMutation({
  args: { productId: v.id("products"), threshold: v.union(v.number(), v.null()) },
  handler: async (ctx, { productId, threshold }) => {
    await ctx.requirePermission("products.set_price");
    const product = await requireProduct(ctx, productId);
    if (threshold !== null && (!Number.isSafeInteger(threshold) || threshold < 0)) {
      throw new ConvexError("The threshold must be a whole number from 0.");
    }
    if (threshold === (product.lowStockThreshold ?? null)) return;
    await ctx.db.patch("products", productId, { lowStockThreshold: threshold ?? undefined });
    await refreshProductStockStatus(ctx, productId);
    await ctx.audit({
      action: "update",
      entityTable: "products",
      entityId: productId,
      businessUnitId: product.businessUnitId,
      before: { name: product.name, sku: product.sku, lowStockThreshold: product.lowStockThreshold ?? null },
      after: { name: product.name, sku: product.sku, lowStockThreshold: threshold },
    });
  },
});

/** Where to upload a product photo (services whose products have one). */
export const generatePhotoUploadUrl = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator },
  handler: async (ctx, { businessUnitKey }) => {
    await ctx.requirePermission("products.manage");
    if (!PRODUCT_PROFILES[businessUnitKey].attributes.photo) {
      throw new ConvexError("Products of this service have no photo.");
    }
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Sets (fileId) or removes (null) a product's photo. The replaced or
 * removed file is deleted from storage. Only for services whose products
 * have a photo (fashion).
 */
export const setPhoto = authedMutation({
  args: { productId: v.id("products"), fileId: v.union(v.id("_storage"), v.null()) },
  handler: async (ctx, { productId, fileId }) => {
    await ctx.requirePermission("products.manage");
    const product = await requireProduct(ctx, productId);
    const unit = (await ctx.db.get("businessUnits", product.businessUnitId))!;
    if (!PRODUCT_PROFILES[unit.key].attributes.photo) {
      throw new ConvexError("Products of this service have no photo.");
    }
    if (fileId === (product.photoFileId ?? null)) return;
    if (fileId) {
      const file = await ctx.db.system.get("_storage", fileId);
      if (!file) throw new ConvexError("Photo upload not found.");
      const problem = photoProblem(file);
      if (problem === "type") throw new ConvexError("The photo must be an image.");
      if (problem === "size") throw new ConvexError("The photo must be 5 MB or smaller.");
    }
    await ctx.db.patch("products", productId, { photoFileId: fileId ?? undefined });
    if (product.photoFileId) await ctx.storage.delete(product.photoFileId);
    await ctx.audit({
      action: "update",
      entityTable: "products",
      entityId: productId,
      businessUnitId: product.businessUnitId,
      before: { name: product.name, sku: product.sku, photo: product.photoFileId ? "attached" : null },
      after: { name: product.name, sku: product.sku, photo: fileId ? "attached" : null },
    });
  },
});

/**
 * Sets (or, with `price: null`, clears) the suggested selling price, in
 * USD cents. Separate from `update` (products.manage, held by everyone):
 * only products.set_price holders decide the price that a sale at another
 * price must justify with a discount reason.
 */
export const setSuggestedPrice = authedMutation({
  args: { productId: v.id("products"), price: v.union(v.number(), v.null()) },
  handler: async (ctx, { productId, price }) => {
    await ctx.requirePermission("products.set_price");
    const product = await requireProduct(ctx, productId);
    if (price !== null && (!Number.isSafeInteger(price) || price < 1)) {
      throw new ConvexError("The price must be a whole number of cents above 0.");
    }
    const changes = diff(
      { name: product.name, sku: product.sku, suggestedPrice: product.suggestedPrice ?? null, currency: "USD" },
      { name: product.name, sku: product.sku, suggestedPrice: price, currency: "USD" },
    );
    if (!changes) return;
    await ctx.db.patch("products", productId, {
      suggestedPrice: price ?? undefined,
      suggestedPriceCurrency: price === null ? undefined : "USD",
    });
    await ctx.audit({
      action: "update",
      entityTable: "products",
      entityId: productId,
      businessUnitId: product.businessUnitId,
      before: { name: product.name, sku: product.sku, ...changes.before },
      after: { name: product.name, sku: product.sku, ...changes.after },
    });
  },
});

/**
 * A chief confirms a product created pending confirmation. Never your own -
 * except the Super Admin (flagged `selfConfirmed` in the audit).
 */
export const confirm = authedMutation({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    await ctx.requirePermission("products.confirm");
    const product = await requireProduct(ctx, productId);
    if (product.status !== "pending_confirmation") {
      throw new ConvexError("This product isn't waiting for confirmation.");
    }
    const selfConfirmed = product.createdBy === ctx.user._id;
    if (selfConfirmed && !ctx.isSuperAdmin) {
      throw new ConvexError("You cannot confirm a product you created.");
    }
    await ctx.db.patch("products", productId, {
      status: "active",
      confirmedBy: ctx.user._id,
      confirmedAt: Date.now(),
    });
    await ctx.audit({
      action: "update",
      entityTable: "products",
      entityId: productId,
      businessUnitId: product.businessUnitId,
      before: { status: "pending_confirmation" },
      after: { status: "active", ...(selfConfirmed ? { selfConfirmed: true } : {}) },
    });
  },
});

/**
 * Archives (hides from use, keeps history) or restores a product. Restoring
 * returns it to active if it was ever confirmed, otherwise to pending.
 */
export const setArchived = authedMutation({
  args: { productId: v.id("products"), archived: v.boolean() },
  handler: async (ctx, { productId, archived }) => {
    await ctx.requirePermission("products.manage");
    const product = await requireProduct(ctx, productId);
    const status = archived
      ? "archived"
      : product.confirmedBy
        ? "active"
        : "pending_confirmation";
    if (product.status === status || (!archived && product.status !== "archived")) {
      return;
    }
    await ctx.db.patch("products", productId, { status });
    await ctx.audit({
      action: "update",
      entityTable: "products",
      entityId: productId,
      businessUnitId: product.businessUnitId,
      before: { status: product.status },
      after: { status },
    });
  },
});

/**
 * Asks for a product to be deleted. Nothing is removed until someone else
 * with deletes.approve approves it (CLAUDE.md "Deletes"). Products already
 * used in stock or requisitions can only be archived.
 */
export const requestDeletion = authedMutation({
  args: { productId: v.id("products"), reason: v.string() },
  handler: async (ctx, { productId, reason }) => {
    await ctx.requirePermission("products.manage");
    const product = await requireProduct(ctx, productId);
    if (!reason.trim()) {
      throw new ConvexError("A reason is required.");
    }
    if (await productUsage.isProductInUse(ctx, productId)) {
      throw new ConvexError(PRODUCT_IN_USE);
    }
    return await requestApproval(ctx, {
      type: "delete",
      businessUnitId: product.businessUnitId,
      entityTable: "products",
      entityId: productId,
      payload: { before: await describe(ctx, product) },
      reason,
    });
  },
});

const REBUILD_BATCH = 100;

/**
 * Recomputes every product's search text (name, SKU, brand, texture,
 * category, length, colour), in batches that re-schedule themselves.
 * Idempotent - only rewrites rows whose text changed. Run after changing
 * what search covers:
 *   pnpm dlx convex run products:rebuildSearchText
 */
export const rebuildSearchText = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("products")
      .paginate({ numItems: REBUILD_BATCH, cursor: cursor ?? null });
    for (const product of page) {
      await refreshProductSearchText(ctx, product);
    }
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.products.rebuildSearchText, {
        cursor: continueCursor,
      });
    }
    return null;
  },
});
