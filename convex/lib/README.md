# convex/lib

Shared server-side helpers, not routable Convex functions themselves.

- `rbac.ts` — **the wrappers every public function must use**:
  `authedQuery` / `authedMutation` / `authedAction` (convex-helpers custom
  functions). They reject unauthenticated/blocked callers and add
  `ctx.user`, `ctx.permissions`, `ctx.can(key)` and
  `ctx.requirePermission(key, scopeCheck?)` to ctx. Every handler calls
  `ctx.requirePermission(...)` for the permission it needs; it returns the
  caller's `scope` (`own_location` | `all_locations`), and an optional
  `scopeCheck(scope, user)` lets a feature reject out-of-scope records.
  Also exports a standalone `requirePermission(ctx, key, scopeCheck?)` and
  `loadPermissions`. Permissions are resolved User -> Role -> Permissions
  fresh on every call, so role edits take effect immediately.
- `permissions.ts` — the typed permission catalog (`PERMISSIONS`,
  `PermissionKey`) and the six `SYSTEM_ROLES` with default grants, seeded by
  `rbac:seedRbac`. Add new permission keys here.
- `businessUnits.ts` — the four business units (`BUSINESS_UNITS`,
  `BusinessUnitKey`) seeded by `businessUnits:seedBusinessUnits`, the
  location type validator, and `getBusinessUnitByKey` /
  `requireBusinessUnit`.
- `auth.ts` — `getCurrentUserOrNull` / `requireCurrentUser` and
  `requireCurrentUserFromAction` (for actions, which have no `ctx.db`). The
  base layer `rbac.ts` builds on; use it directly only for functions that
  need no permission (e.g. `users.getCurrentUser`, `users.changePassword`).
- `audit.ts` — `logAudit` (the only writer of the append-only `auditLogs`
  table; inside `authedMutation` use `ctx.audit`, which fills the actor),
  `snapshot` / `diff` for before/after, and the `auditActionValidator`.
- `approvals.ts` — the approval engine: `requestApproval` (from an
  authedMutation), `insertApproval`, `DEFAULT_REQUIRED_PERMISSION`, and the
  `canDecide` / `canSeeApproval` rules shared by `convex/approvals.ts`.
- `approvalTypes.ts` — the approval type/status/decision validators. Add
  new approval types here.
- `approvalHandlers.ts` — `APPROVAL_HANDLERS`, one handler per type that
  applies an approved change (stubs until each feature registers its own),
  `DELETE_HANDLERS` (by table) and the optional
  `APPROVAL_REJECTION_HANDLERS` (status bookkeeping on reject).
- `products.ts` — product catalogue constants (categories, units,
  statuses), `PRODUCT_PROFILES` (what each service's products look like:
  hair length/texture, fashion size), `productDetails` (length, size,
  colour for display), `nextSku`, `searchTextFor`,
  `productUsage.isProductInUse` (requisition and stock batch lines) and the
  approved product delete handler.
- `money.ts` — `currencyValidator` / `usdValidator`, `parseMoneyToMinor`,
  `minorToInput`, `formatMoney` (shared with the UI's `MoneyInput`).
- `stockBatches.ts` — batch/line/expense validators, `lineProblems`,
  `resolutionFor`, `receiptProblem`, receiving rules (`receiveProblems`,
  `missingQty`), requisition status/link syncing, and the `stock_batch`
  approval + rejection handlers.
- `inventory.ts` — the inventory core: holders (`getOrCreateHolder`,
  `findHolder`, `holderName`), `applyMovement` (THE only writer of
  `stockLevels` / `inventoryMovements`; never goes below zero) and
  `groupStock` (the overview's by product / lot / holder views).
- `sales.ts` — payment methods and sale statuses, `saleLineProblems` (quantity,
  price, discount reason vs the suggested price) and `lineMargin`.
- `analytics.ts` — the analytics rollups (`dailyStats`, `dailyFinance`):
  event builders, `applyRollupEvent(s)` (the only writer), `computeRollups`
  and `rebuildRollups` (backfill), and range helpers (`resolveRange`,
  `bucketsBetween`, Monday weeks).
- `payroll.ts` — payroll statuses, `isPeriod` / `addMonths` (a period is a
  month) and the `payroll` approval + rejection handlers.
- `withdrawals.ts` — withdrawal statuses and the `withdrawal` approval +
  rejection handlers (withdrawals are never a business cost).
- `locationScope.ts` — the location lock for location-bound records
  (`pickableLocations`, `locationFor`) and `activePeople`.
- `distributions.ts` — distribution statuses and the `distribution`
  approval (moves the stock) + rejection handlers.
- `stock.test.utils.ts` — test-only stock setup shared by the stock tests
  (`setupStock`, `buildMixedBatch`, `arrivedMixedBatch`, `receiveAll`).
- `requisitions.ts` — requisition statuses/resolutions, `isEditable`,
  `nextSequenceNumber` (per-unit document numbers like `REQ-00001`), and
  the requisition approval + rejection handlers.
- `time.ts` — business time zone (Africa/Lubumbashi, UTC+2) helpers:
  `businessDayStartUtc` / `businessDayEndUtc` turn a YYYY-MM-DD business
  day into a UTC ms range.
- `password.ts` — `generateStrongPassword`, used for admin-created accounts.
- `test.utils.ts` — test-only helpers (`seedReferenceDataForTest`,
  `insertUserWithRole`, `getRoleId`, `insertLocation`, `getBusinessUnitId`) shared by `convex/*.test.ts`. The
  double dot is deliberate: the Convex CLI skips multi-dot files, so it is
  never pushed. Any file under `convex/` with an import/export is pushed as
  a module, and module names can't contain hyphens.
- `test-setup.ts` — Vitest `setupFiles` entry providing a test-only JWT
  keypair so `@convex-dev/auth` can sign session tokens inside
  `convex-test`'s mock backend. Not used against any real deployment.
