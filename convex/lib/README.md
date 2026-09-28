# convex/lib

Shared server-side helpers, not routable Convex functions themselves.

- `auth.ts` — `getCurrentUserOrNull` / `requireCurrentUser` / `requireSuperAdmin`
  (query/mutation context) and their `...FromAction` counterparts (for
  actions, which have no `ctx.db`). This is the "shared wrapper" CLAUDE.md's
  permissions rule requires — every function that needs an authenticated or
  Super Admin caller goes through these rather than checking ad hoc. A real
  role/permission check (beyond `isSuperAdmin`) lands in a later step.
- `audit.ts` — `logUserAudit`, appends to the append-only `auditLogs` table.
- `password.ts` — `generateStrongPassword`, used for admin-created accounts.
- `test-setup.ts` — Vitest `setupFiles` entry providing a test-only JWT
  keypair so `@convex-dev/auth` can sign session tokens inside
  `convex-test`'s mock backend. Not used against any real deployment.
