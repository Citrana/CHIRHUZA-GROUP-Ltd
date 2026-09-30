/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as approvals from "../approvals.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as businessUnits from "../businessUnits.js";
import type * as distributions from "../distributions.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as inventory from "../inventory.js";
import type * as lib_approvalHandlers from "../lib/approvalHandlers.js";
import type * as lib_approvalTypes from "../lib/approvalTypes.js";
import type * as lib_approvals from "../lib/approvals.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_businessUnits from "../lib/businessUnits.js";
import type * as lib_distributions from "../lib/distributions.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_password from "../lib/password.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_products from "../lib/products.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as lib_requisitions from "../lib/requisitions.js";
import type * as lib_stockBatches from "../lib/stockBatches.js";
import type * as lib_time from "../lib/time.js";
import type * as locations from "../locations.js";
import type * as productOptions from "../productOptions.js";
import type * as products from "../products.js";
import type * as rbac from "../rbac.js";
import type * as requisitions from "../requisitions.js";
import type * as seed from "../seed.js";
import type * as stockBatches from "../stockBatches.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  approvals: typeof approvals;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  businessUnits: typeof businessUnits;
  distributions: typeof distributions;
  healthCheck: typeof healthCheck;
  http: typeof http;
  inventory: typeof inventory;
  "lib/approvalHandlers": typeof lib_approvalHandlers;
  "lib/approvalTypes": typeof lib_approvalTypes;
  "lib/approvals": typeof lib_approvals;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/businessUnits": typeof lib_businessUnits;
  "lib/distributions": typeof lib_distributions;
  "lib/inventory": typeof lib_inventory;
  "lib/money": typeof lib_money;
  "lib/password": typeof lib_password;
  "lib/permissions": typeof lib_permissions;
  "lib/products": typeof lib_products;
  "lib/rbac": typeof lib_rbac;
  "lib/requisitions": typeof lib_requisitions;
  "lib/stockBatches": typeof lib_stockBatches;
  "lib/time": typeof lib_time;
  locations: typeof locations;
  productOptions: typeof productOptions;
  products: typeof products;
  rbac: typeof rbac;
  requisitions: typeof requisitions;
  seed: typeof seed;
  stockBatches: typeof stockBatches;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
