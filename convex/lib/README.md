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
  `BusinessUnitKey`) seeded by `businessUnits:seedBusinessUnits`, plus the
  location type validator.
- `auth.ts` — `getCurrentUserOrNull` / `requireCurrentUser` and
  `requireCurrentUserFromAction` (for actions, which have no `ctx.db`). The
  base layer `rbac.ts` builds on; use it directly only for functions that
  need no permission (e.g. `users.getCurrentUser`, `users.changePassword`).
- `audit.ts` — `logAudit` (the only writer of the append-only `auditLogs`
  table; inside `authedMutation` use `ctx.audit`, which fills the actor),
  `snapshot` / `diff` for before/after, and the `auditActionValidator`.
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
