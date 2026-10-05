/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analytics from "../analytics.js";
import type * as approvals from "../approvals.js";
import type * as auditLogs from "../auditLogs.js";
import type * as auth from "../auth.js";
import type * as businessUnits from "../businessUnits.js";
import type * as credit from "../credit.js";
import type * as customers from "../customers.js";
import type * as distributions from "../distributions.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as inventory from "../inventory.js";
import type * as lib_analytics from "../lib/analytics.js";
import type * as lib_approvalHandlers from "../lib/approvalHandlers.js";
import type * as lib_approvalTypes from "../lib/approvalTypes.js";
import type * as lib_approvals from "../lib/approvals.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_businessUnits from "../lib/businessUnits.js";
import type * as lib_credit from "../lib/credit.js";
import type * as lib_distributions from "../lib/distributions.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_locationScope from "../lib/locationScope.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_password from "../lib/password.js";
import type * as lib_payroll from "../lib/payroll.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_products from "../lib/products.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as lib_requisitions from "../lib/requisitions.js";
import type * as lib_sales from "../lib/sales.js";
import type * as lib_stockBatches from "../lib/stockBatches.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_withdrawals from "../lib/withdrawals.js";
import type * as locations from "../locations.js";
import type * as payroll from "../payroll.js";
import type * as productOptions from "../productOptions.js";
import type * as products from "../products.js";
import type * as rbac from "../rbac.js";
import type * as requisitions from "../requisitions.js";
import type * as sales from "../sales.js";
import type * as seed from "../seed.js";
import type * as stockBatches from "../stockBatches.js";
import type * as users from "../users.js";
import type * as withdrawals from "../withdrawals.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analytics: typeof analytics;
  approvals: typeof approvals;
  auditLogs: typeof auditLogs;
  auth: typeof auth;
  businessUnits: typeof businessUnits;
  credit: typeof credit;
  customers: typeof customers;
  distributions: typeof distributions;
  healthCheck: typeof healthCheck;
  http: typeof http;
  inventory: typeof inventory;
  "lib/analytics": typeof lib_analytics;
  "lib/approvalHandlers": typeof lib_approvalHandlers;
  "lib/approvalTypes": typeof lib_approvalTypes;
  "lib/approvals": typeof lib_approvals;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/businessUnits": typeof lib_businessUnits;
  "lib/credit": typeof lib_credit;
  "lib/distributions": typeof lib_distributions;
  "lib/inventory": typeof lib_inventory;
  "lib/locationScope": typeof lib_locationScope;
  "lib/money": typeof lib_money;
  "lib/password": typeof lib_password;
  "lib/payroll": typeof lib_payroll;
  "lib/permissions": typeof lib_permissions;
  "lib/products": typeof lib_products;
  "lib/rbac": typeof lib_rbac;
  "lib/requisitions": typeof lib_requisitions;
  "lib/sales": typeof lib_sales;
  "lib/stockBatches": typeof lib_stockBatches;
  "lib/time": typeof lib_time;
  "lib/withdrawals": typeof lib_withdrawals;
  locations: typeof locations;
  payroll: typeof payroll;
  productOptions: typeof productOptions;
  products: typeof products;
  rbac: typeof rbac;
  requisitions: typeof requisitions;
  sales: typeof sales;
  seed: typeof seed;
  stockBatches: typeof stockBatches;
  users: typeof users;
  withdrawals: typeof withdrawals;
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
