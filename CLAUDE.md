@AGENTS.md

# CHIRHUZA GROUP Ltd — Business Management Platform

A multi-service business management platform covering four business units:
**hair, fashion, housing, transport**. Stack: Next.js (App Router), TypeScript
(strict), Tailwind, shadcn/ui, Convex.

This file records **permanent rules**. They apply to every feature built in
this repo, now and later — do not relax them for convenience.

## Permissions & security

- Every Convex function enforces permissions server-side, through shared
  wrappers (to be added in `convex/lib/`). Never rely on hiding UI elements
  as a substitute for a server-side check — the client is not trusted.

## Money

- Money is stored as an **integer** in minor units (e.g. cents), plus a
  separate `currency` field typed `"USD" | "CDF"`. Never store money as a
  float, and never store an amount without its currency.

## Multi-tenancy (business units)

- Every business table has a `businessUnitId` field identifying which
  service it belongs to (`hair`, `fashion`, `housing`, `transport`), unless
  the table is truly global (e.g. shared reference/config data). Default to
  scoping by business unit; only omit it with a clear reason.

## Time

- The business time zone is **Africa/Lubumbashi (UTC+2)**. All day/week/month
  bucketing (reports, schedules, "today", etc.) is computed in that time
  zone, never in server-local or UTC-calendar terms.
- Timestamps are stored as **UTC milliseconds** (`number`); conversion to the
  business time zone happens at read/aggregation time, not at write time.

## Deletes

- Deletes of business data are never immediate. A delete goes through an
  **approval request** (soft delete): the record is flagged/queued, not
  removed, until an approver acts on it.

## Audit logging

- Every add, update, and delete writes an entry to an audit log table.

## Approvals

- Nobody can approve their own request (delete approvals or otherwise). The
  requester and the approver must always be different users.

## Append-only tables

- Append-only tables — the audit log, inventory movements, and similar
  event-style tables — are **never** updated or deleted after being written.
  Correct a mistake with a new compensating entry, not a mutation.

## Internationalization

- The platform supports **English and French**, always. Every piece of UI
  built — every page, component, label, button, toast, error message, email
  template — ships with translations for both languages from the start. A
  feature that only has English text is not done.
- User-facing strings live in `messages/en.json` and `messages/fr.json`
  (via `next-intl`), never hardcoded in components. Add a key to both files
  together, in the same commit.
- Routing is locale-prefixed (`/en/...`, `/fr/...`) via `src/i18n/routing.ts`
  and `src/proxy.ts`. New routes go under `src/app/[locale]/`.
- Use `getTranslations`/`useTranslations` (scoped per component/page, e.g.
  `"Home"`) rather than a flat global namespace.

## Workflow

- Prefer small, focused commits.
- Every feature ships with basic tests for its Convex logic. This is
  non-negotiable — no Convex query, mutation, or action merges without a
  test covering its main behavior (and, where relevant, its permission
  checks and edge cases).
- **Branch naming**: `<type>/<kebab-case-description>`, e.g.
  `feat/add-login-page`, `fix/broken-invoice-total`. Allowed types: `feat`,
  `fix`, `refactor`, `chore`, `docs`, `test`. `main` and `develop` are the
  only exceptions. This is enforced by a Husky `pre-commit` hook
  (`.husky/pre-commit`) — a badly named branch fails the commit outright.
- **Tests gate every commit**: the same `pre-commit` hook runs `pnpm test`
  (Vitest) before the commit is allowed through. Any failing test blocks
  the commit; Vitest prints a full per-file pass/fail report in the
  terminal. Hooks are installed automatically by `pnpm install` (via the
  `prepare` script) — no manual setup needed after cloning.

## Authentication

- Authentication is Convex Auth (`@convex-dev/auth`), email + password only.
  There is no public self-serve sign-up — accounts are created exclusively
  by a Super Admin (see `createUser` in `convex/users.ts`), which generates
  a strong password shown to the admin exactly once.
- `users.status` (`"active" | "blocked"`) is enforced in two places: Convex
  Auth's `beforeSessionCreation` callback (`convex/auth.ts`) rejects sign-in
  outright for a blocked user, and `getCurrentUserOrNull`
  (`convex/lib/auth.ts`) re-checks status on every subsequent call, since a
  user can be blocked after their session already exists.
- Route protection is **client-side only** (`src/components/auth-gate.tsx`,
  using `useConvexAuth()`), not Next.js middleware/proxy-based. Convex
  Auth's server-side route protection has an open upstream bug with
  Next.js's `proxy.ts` convention (get-convex/convex-auth#271), which this
  repo uses. The real security boundary is still server-side — every
  Convex function must go through `convex/lib/auth.ts`'s helpers
  (`requireCurrentUser`, `requireSuperAdmin`, or their `...FromAction`
  variants), per the Permissions & security rule above.
- `roleId` and `isSuperAdmin` on `users` are placeholders: `roleId` stays
  `null` until the roles/permissions system exists; `isSuperAdmin` is a
  temporary stand-in for "can manage users" until real permission checks
  replace it.

## Project layout

```
convex/
  schema.ts        # single source of truth for all tables
  auth.ts           # Convex Auth config (Password provider, callbacks)
  auth.config.ts    # required by Convex Auth (JWT provider)
  http.ts           # required by Convex Auth (auth HTTP routes)
  seed.ts           # bootstraps the first Super Admin from env vars
  lib/              # shared server-side wrappers (permissions, audit, etc.)
  <domain>.ts       # one file per domain/feature (e.g. hair.ts, fashion.ts)
  <domain>.test.ts  # tests for that domain's Convex logic
messages/
  en.json           # UI strings, English
  fr.json           # UI strings, French — kept in lockstep with en.json
src/
  app/[locale]/     # Next.js App Router routes, locale-prefixed
  components/       # UI components (shadcn primitives in components/ui/)
  i18n/             # next-intl routing, navigation, request config
  lib/              # client-side utilities, Convex client provider
  proxy.ts          # locale-detection proxy (Next.js's middleware convention)
```

## Current status

This repo has: project setup, Convex connection, folder structure, i18n
(English/French) routing, and authentication (Convex Auth, email +
password, admin-created accounts, block/unblock, forced password change).
No roles/permissions system yet, and no business features — they come in
later steps, built on top of the rules above.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
