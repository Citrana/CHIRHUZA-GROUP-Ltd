import { v, ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/rbac";
import {
  businessUnitKeyValidator,
  requireBusinessUnit,
} from "./lib/businessUnits";
import { normalizeColourName, refreshProductSearchText } from "./lib/products";

/**
 * Per-business-unit product settings: the lengths (whole inches, hair),
 * sizes (fashion) and colours that product forms can pick from. Values are deactivated, never
 * deleted, so products that already use one keep it. Reading needs
 * products.view (the product form uses these lists); changes need
 * products.settings and are audited.
 */

const MAX_INCHES = 60;

// Counting stops here; the UI only needs "none" vs "some (N)".
const USAGE_COUNT_LIMIT = 1000;

/** How many products (any status) use this length in its business unit. */
async function countLengthUsage(
  ctx: QueryCtx,
  businessUnitId: Id<"businessUnits">,
  inches: number,
): Promise<number> {
  const products = await ctx.db
    .query("products")
    .withIndex("by_businessUnitId_and_lengthInches", (q) =>
      q.eq("businessUnitId", businessUnitId).eq("lengthInches", inches),
    )
    .take(USAGE_COUNT_LIMIT);
  return products.length;
}

/** How many products (any status) use this colour. */
async function countColourUsage(
  ctx: QueryCtx,
  colourId: Id<"productColours">,
): Promise<number> {
  const products = await ctx.db
    .query("products")
    .withIndex("by_colourId", (q) => q.eq("colourId", colourId))
    .take(USAGE_COUNT_LIMIT);
  return products.length;
}

/**
 * A setting used by any product can't be deleted (deactivate it instead).
 * Structured so the UI can show a translated message with the count.
 */
function inUseError(count: number) {
  return new ConvexError({ code: "IN_USE" as const, count });
}

/**
 * Lengths and colours are unique per service - including deactivated ones
 * (reactivate those instead). Structured so the UI can explain it.
 */
function duplicateError() {
  return new ConvexError({ code: "DUPLICATE" as const });
}

function cleanColourName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new ConvexError("Colour name is required.");
  }
  if (trimmed.length > 50) {
    throw new ConvexError("Colour name is too long.");
  }
  return trimmed;
}

export const listLengths = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, { businessUnitKey, includeInactive }) => {
    await ctx.requirePermission("products.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const lengths = await ctx.db
      .query("productLengths")
      .withIndex("by_businessUnitId_and_inches", (q) =>
        q.eq("businessUnitId", unit._id),
      )
      .take(200);
    const shown = includeInactive ? lengths : lengths.filter((l) => l.active);
    return await Promise.all(
      shown.map(async (length) => ({
        ...length,
        productCount: await countLengthUsage(ctx, unit._id, length.inches),
      })),
    );
  },
});

export const listColours = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, { businessUnitKey, includeInactive }) => {
    await ctx.requirePermission("products.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const colours = await ctx.db
      .query("productColours")
      .withIndex("by_businessUnitId_and_name", (q) =>
        q.eq("businessUnitId", unit._id),
      )
      .take(500);
    const shown = includeInactive ? colours : colours.filter((c) => c.active);
    return await Promise.all(
      shown.map(async (colour) => ({
        ...colour,
        productCount: await countColourUsage(ctx, colour._id),
      })),
    );
  },
});

export const addLength = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, inches: v.number() },
  handler: async (ctx, { businessUnitKey, inches }) => {
    await ctx.requirePermission("products.settings");
    if (!Number.isInteger(inches) || inches < 1 || inches > MAX_INCHES) {
      throw new ConvexError(`Length must be a whole number from 1 to ${MAX_INCHES} inches.`);
    }
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const existing = await ctx.db
      .query("productLengths")
      .withIndex("by_businessUnitId_and_inches", (q) =>
        q.eq("businessUnitId", unit._id).eq("inches", inches),
      )
      .unique();
    if (existing) {
      throw duplicateError();
    }
    const id = await ctx.db.insert("productLengths", {
      businessUnitId: unit._id,
      inches,
      active: true,
    });
    await ctx.audit({
      action: "create",
      entityTable: "productLengths",
      entityId: id,
      businessUnitId: unit._id,
      after: { inches, active: true },
    });
    return id;
  },
});

export const setLengthActive = authedMutation({
  args: { lengthId: v.id("productLengths"), active: v.boolean() },
  handler: async (ctx, { lengthId, active }) => {
    await ctx.requirePermission("products.settings");
    const length = await ctx.db.get("productLengths", lengthId);
    if (!length) {
      throw new ConvexError("Length not found.");
    }
    if (length.active === active) {
      return;
    }
    await ctx.db.patch("productLengths", lengthId, { active });
    await ctx.audit({
      action: "update",
      entityTable: "productLengths",
      entityId: lengthId,
      businessUnitId: length.businessUnitId,
      before: { inches: length.inches, active: length.active },
      after: { inches: length.inches, active },
    });
  },
});

async function assertColourNameFree(
  ctx: QueryCtx,
  businessUnitId: Id<"businessUnits">,
  name: string,
  exceptId?: Id<"productColours">,
) {
  const colours = await ctx.db
    .query("productColours")
    .withIndex("by_businessUnitId_and_name", (q) =>
      q.eq("businessUnitId", businessUnitId),
    )
    .take(500);
  const wanted = normalizeColourName(name);
  const clash = colours.find(
    (c) => c._id !== exceptId && normalizeColourName(c.name) === wanted,
  );
  if (clash) {
    throw duplicateError();
  }
}

export const addColour = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, name: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("products.settings");
    const name = cleanColourName(args.name);
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    await assertColourNameFree(ctx, unit._id, name);
    const id = await ctx.db.insert("productColours", {
      businessUnitId: unit._id,
      name,
      active: true,
    });
    await ctx.audit({
      action: "create",
      entityTable: "productColours",
      entityId: id,
      businessUnitId: unit._id,
      after: { name, active: true },
    });
    return id;
  },
});

export const renameColour = authedMutation({
  args: { colourId: v.id("productColours"), name: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("products.settings");
    const colour = await ctx.db.get("productColours", args.colourId);
    if (!colour) {
      throw new ConvexError("Colour not found.");
    }
    const name = cleanColourName(args.name);
    if (name === colour.name) {
      return;
    }
    await assertColourNameFree(ctx, colour.businessUnitId, name, colour._id);
    await ctx.db.patch("productColours", colour._id, { name });
    // Products are searchable by colour name: keep their search text current.
    const products = await ctx.db
      .query("products")
      .withIndex("by_colourId", (q) => q.eq("colourId", colour._id))
      .take(USAGE_COUNT_LIMIT);
    for (const product of products) {
      await refreshProductSearchText(ctx, product);
    }
    await ctx.audit({
      action: "update",
      entityTable: "productColours",
      entityId: colour._id,
      businessUnitId: colour.businessUnitId,
      before: { name: colour.name },
      after: { name },
    });
  },
});

export const setColourActive = authedMutation({
  args: { colourId: v.id("productColours"), active: v.boolean() },
  handler: async (ctx, { colourId, active }) => {
    await ctx.requirePermission("products.settings");
    const colour = await ctx.db.get("productColours", colourId);
    if (!colour) {
      throw new ConvexError("Colour not found.");
    }
    if (colour.active === active) {
      return;
    }
    await ctx.db.patch("productColours", colourId, { active });
    await ctx.audit({
      action: "update",
      entityTable: "productColours",
      entityId: colourId,
      businessUnitId: colour.businessUnitId,
      before: { name: colour.name, active: colour.active },
      after: { name: colour.name, active },
    });
  },
});

/**
 * Deletes a length no product uses (settings, so no approval request -
 * but audited). A length in use can only be deactivated.
 */
export const deleteLength = authedMutation({
  args: { lengthId: v.id("productLengths") },
  handler: async (ctx, { lengthId }) => {
    await ctx.requirePermission("products.settings");
    const length = await ctx.db.get("productLengths", lengthId);
    if (!length) {
      throw new ConvexError("Length not found.");
    }
    const count = await countLengthUsage(ctx, length.businessUnitId, length.inches);
    if (count > 0) {
      throw inUseError(count);
    }
    await ctx.db.delete("productLengths", lengthId);
    await ctx.audit({
      action: "delete",
      entityTable: "productLengths",
      entityId: lengthId,
      businessUnitId: length.businessUnitId,
      before: { inches: length.inches, active: length.active },
    });
  },
});

/** Deletes a colour no product uses (audited). A colour in use can only be deactivated. */
export const deleteColour = authedMutation({
  args: { colourId: v.id("productColours") },
  handler: async (ctx, { colourId }) => {
    await ctx.requirePermission("products.settings");
    const colour = await ctx.db.get("productColours", colourId);
    if (!colour) {
      throw new ConvexError("Colour not found.");
    }
    const count = await countColourUsage(ctx, colourId);
    if (count > 0) {
      throw inUseError(count);
    }
    await ctx.db.delete("productColours", colourId);
    await ctx.audit({
      action: "delete",
      entityTable: "productColours",
      entityId: colourId,
      businessUnitId: colour.businessUnitId,
      before: { name: colour.name, active: colour.active },
    });
  },
});

// ------------------------------------------------------------------ sizes
// Fashion sizes (e.g. "S", "M", "42"): like colours, plus an order the
// settings page controls (sortOrder) so pickers list them XS -> XXL.

function cleanSizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) throw new ConvexError("Size name is required.");
  if (trimmed.length > 20) throw new ConvexError("Size name is too long.");
  return trimmed;
}

async function unitSizes(ctx: QueryCtx, businessUnitId: Id<"businessUnits">) {
  return await ctx.db
    .query("productSizes")
    .withIndex("by_businessUnitId_and_sortOrder", (q) => q.eq("businessUnitId", businessUnitId))
    .take(500);
}

async function assertSizeNameFree(
  ctx: QueryCtx,
  businessUnitId: Id<"businessUnits">,
  name: string,
  exceptId?: Id<"productSizes">,
) {
  const wanted = normalizeColourName(name);
  const clash = (await unitSizes(ctx, businessUnitId)).find(
    (s) => s._id !== exceptId && normalizeColourName(s.name) === wanted,
  );
  if (clash) throw duplicateError();
}

/** How many products (any status) use this size. */
async function countSizeUsage(ctx: QueryCtx, sizeId: Id<"productSizes">): Promise<number> {
  const products = await ctx.db
    .query("products")
    .withIndex("by_sizeId", (q) => q.eq("sizeId", sizeId))
    .take(USAGE_COUNT_LIMIT);
  return products.length;
}

export const listSizes = authedQuery({
  args: {
    businessUnitKey: businessUnitKeyValidator,
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, { businessUnitKey, includeInactive }) => {
    await ctx.requirePermission("products.view");
    const unit = await requireBusinessUnit(ctx, businessUnitKey);
    const sizes = await unitSizes(ctx, unit._id);
    const shown = includeInactive ? sizes : sizes.filter((s) => s.active);
    return await Promise.all(
      shown.map(async (size) => ({ ...size, productCount: await countSizeUsage(ctx, size._id) })),
    );
  },
});

export const addSize = authedMutation({
  args: { businessUnitKey: businessUnitKeyValidator, name: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("products.settings");
    const name = cleanSizeName(args.name);
    const unit = await requireBusinessUnit(ctx, args.businessUnitKey);
    await assertSizeNameFree(ctx, unit._id, name);
    const sizes = await unitSizes(ctx, unit._id);
    const sortOrder = (sizes.at(-1)?.sortOrder ?? 0) + 1;
    const id = await ctx.db.insert("productSizes", { businessUnitId: unit._id, name, sortOrder, active: true });
    await ctx.audit({
      action: "create",
      entityTable: "productSizes",
      entityId: id,
      businessUnitId: unit._id,
      after: { name, active: true },
    });
    return id;
  },
});

export const renameSize = authedMutation({
  args: { sizeId: v.id("productSizes"), name: v.string() },
  handler: async (ctx, args) => {
    await ctx.requirePermission("products.settings");
    const size = await ctx.db.get("productSizes", args.sizeId);
    if (!size) throw new ConvexError("Size not found.");
    const name = cleanSizeName(args.name);
    if (name === size.name) return;
    await assertSizeNameFree(ctx, size.businessUnitId, name, size._id);
    await ctx.db.patch("productSizes", size._id, { name });
    // Products are searchable by size: keep their search text current.
    const products = await ctx.db
      .query("products")
      .withIndex("by_sizeId", (q) => q.eq("sizeId", size._id))
      .take(USAGE_COUNT_LIMIT);
    for (const product of products) {
      await refreshProductSearchText(ctx, product);
    }
    await ctx.audit({
      action: "update",
      entityTable: "productSizes",
      entityId: size._id,
      businessUnitId: size.businessUnitId,
      before: { name: size.name },
      after: { name },
    });
  },
});

/** Moves a size one place up or down in the list (swaps with its neighbour). */
export const moveSize = authedMutation({
  args: { sizeId: v.id("productSizes"), direction: v.union(v.literal("up"), v.literal("down")) },
  handler: async (ctx, { sizeId, direction }) => {
    await ctx.requirePermission("products.settings");
    const size = await ctx.db.get("productSizes", sizeId);
    if (!size) throw new ConvexError("Size not found.");
    const sizes = await unitSizes(ctx, size.businessUnitId);
    const index = sizes.findIndex((s) => s._id === sizeId);
    const other = sizes[direction === "up" ? index - 1 : index + 1];
    if (!other) return;
    await ctx.db.patch("productSizes", size._id, { sortOrder: other.sortOrder });
    await ctx.db.patch("productSizes", other._id, { sortOrder: size.sortOrder });
    await ctx.audit({
      action: "update",
      entityTable: "productSizes",
      entityId: size._id,
      businessUnitId: size.businessUnitId,
      before: { name: size.name, position: index + 1 },
      after: { name: size.name, position: direction === "up" ? index : index + 2 },
    });
  },
});

export const setSizeActive = authedMutation({
  args: { sizeId: v.id("productSizes"), active: v.boolean() },
  handler: async (ctx, { sizeId, active }) => {
    await ctx.requirePermission("products.settings");
    const size = await ctx.db.get("productSizes", sizeId);
    if (!size) throw new ConvexError("Size not found.");
    if (size.active === active) return;
    await ctx.db.patch("productSizes", sizeId, { active });
    await ctx.audit({
      action: "update",
      entityTable: "productSizes",
      entityId: sizeId,
      businessUnitId: size.businessUnitId,
      before: { name: size.name, active: size.active },
      after: { name: size.name, active },
    });
  },
});

/** Deletes a size no product uses (audited). A size in use can only be deactivated. */
export const deleteSize = authedMutation({
  args: { sizeId: v.id("productSizes") },
  handler: async (ctx, { sizeId }) => {
    await ctx.requirePermission("products.settings");
    const size = await ctx.db.get("productSizes", sizeId);
    if (!size) throw new ConvexError("Size not found.");
    const count = await countSizeUsage(ctx, sizeId);
    if (count > 0) throw inUseError(count);
    await ctx.db.delete("productSizes", sizeId);
    await ctx.audit({
      action: "delete",
      entityTable: "productSizes",
      entityId: sizeId,
      businessUnitId: size.businessUnitId,
      before: { name: size.name, active: size.active },
    });
  },
});
