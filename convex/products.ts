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
  productCategoryValidator,
  productStatusValidator,
  productUnitValidator,
  productUsage,
  computeSearchText,
  refreshProductSearchText,
} from "./lib/products";

/**
 * The product catalogue (no prices - see convex/lib/products.ts). Every
 * change is audited; deletes go through the approval engine.
 */

const editableFields = {
  name: v.string(),
  category: productCategoryValidator,
  unit: productUnitValidator,
  brand: v.optional(v.string()),
  texture: v.optional(v.string()),
  lengthInches: v.optional(v.number()),
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
  businessUnitId: Id<"businessUnits">,
  next: { lengthInches?: number; colourId?: Id<"productColours"> },
  current?: Doc<"products">,
) {
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
  return {
    name: product.name,
    sku: product.sku,
    category: product.category,
    unit: product.unit,
    brand: product.brand ?? null,
    texture: product.texture ?? null,
    lengthInches: product.lengthInches ?? null,
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
          const colour = product.colourId
            ? await ctx.db.get("productColours", product.colourId)
            : null;
          return {
            ...product,
            colourName: colour?.name ?? null,
            pendingDeletion: (await pendingDeletionFor(ctx, product._id)) !== null,
          };
        }),
      ),
    };
  },
});

/** One product for the detail drawer, with what this user may do to it. */
export const get = authedQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    await ctx.requirePermission("products.view");
    const product = await ctx.db.get("products", productId);
    if (!product) return null;
    const colour = product.colourId ? await ctx.db.get("productColours", product.colourId) : null;
    const creator = await ctx.db.get("users", product.createdBy);
    const confirmer = product.confirmedBy ? await ctx.db.get("users", product.confirmedBy) : null;
    return {
      ...product,
      colourName: colour?.name ?? null,
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
    await assertValidOptions(ctx, unit._id, args);

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
    await assertValidOptions(ctx, product.businessUnitId, args, product);

    const next = {
      ...product,
      name,
      category: args.category,
      unit: args.unit,
      brand,
      texture,
      lengthInches: args.lengthInches,
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
      colourId: args.colourId,
      searchText: await computeSearchText(ctx, {
        name,
        sku: product.sku,
        category: args.category,
        brand,
        texture,
        lengthInches: args.lengthInches,
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
