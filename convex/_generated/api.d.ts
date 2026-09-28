/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as businessUnits from "../businessUnits.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_businessUnits from "../lib/businessUnits.js";
import type * as lib_password from "../lib/password.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as locations from "../locations.js";
import type * as rbac from "../rbac.js";
import type * as seed from "../seed.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  businessUnits: typeof businessUnits;
  healthCheck: typeof healthCheck;
  http: typeof http;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/businessUnits": typeof lib_businessUnits;
  "lib/password": typeof lib_password;
  "lib/permissions": typeof lib_permissions;
  "lib/rbac": typeof lib_rbac;
  locations: typeof locations;
  rbac: typeof rbac;
  seed: typeof seed;
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
