@AGENTS.md

# CHIRHUZA GROUP Ltd — Business Management Platform

A multi-service business management platform covering four business units:
**hair, fashion, housing, transport**. Stack: Next.js (App Router), TypeScript
(strict), Tailwind, shadcn/ui, Convex.

This file records **permanent rules**. They apply to every feature built in
this repo, now and later — do not relax them for convenience.

## Permissions & security

- Every Convex function enforces permissions server-side, through shared
  wrappers in `convex/lib/rbac.ts`. Never rely on hiding UI elements
  as a substitute for a server-side check — the client is not trusted.
- RBAC is **User -> Role -> Permissions** (`users.roleId` -> `roles` ->
  `rolePermissions` -> `permissions`). There is no direct user-to-permission
  link. Each role-permission link has a scope: `own_location` |
  `all_locations`.
- Every public function is built with `authedQuery` / `authedMutation` /
  `authedAction` (convex-helpers custom functions, `convex/lib/rbac.ts`)
  and calls `ctx.requirePermission("<key>", scopeCheck?)` for the
  permission it needs. It returns the caller's scope; features with
  location-bound records pass a `scopeCheck` to reject out-of-scope access.
- Permission keys are a typed catalog in `convex/lib/permissions.ts`
  (`PERMISSIONS`, `PermissionKey`), alongside the six `SYSTEM_ROLES` and
  their default grants. A new key goes there, then into
  `messages/{en,fr}.json` under `Permissions`, then `npx convex run
  seed:seedReferenceData` (idempotent; never overwrites an edited role's
  grants). Role defaults only apply when a role is first created — to give
  a new key to roles that already exist, add a one-shot entry to
  `SEED_STEPS` (applied once, recorded in `appliedSeedSteps`); a step can
  also `revokes` grants from existing roles.
- The Super Admin role is locked: it always holds every permission and
  can't be edited, and the last active Super Admin can't be demoted or
  blocked.
- The Super Admin can do **everything** on the platform: besides holding
  every permission, they are exempt from separation-of-duties rules
  (approving their own requests, confirming products they created, editing
  others' draft/rejected requisitions). Check `ctx.isSuperAdmin` for such
  exemptions, and flag self-actions in the audit (e.g. `selfApproved`,
  `selfConfirmed`). The lock-out guards (own role/status, last Super Admin)
  still apply to them.
- Frontend: `useCan(key)` / `useCanAnyInModule(module)`
  (`src/lib/use-can.ts`) hide UI only. Skip (`"skip"`) queries the user
  can't run rather than letting them throw.

## Money

- Money is stored as an **integer** in minor units (e.g. cents), plus a
  separate `currency` field typed `"USD" | "CDF"`. Never store money as a
  float, and never store an amount without its currency.
- Use `convex/lib/money.ts` (`currencyValidator`, `parseMoneyToMinor`,
  `formatMoney`) and the `<MoneyInput>` component for entry — never parse
  or format money by hand. Stock purchasing is USD only (`usdValidator`).
- In audit snapshots and approval payloads, name money fields `amount` or
  `…Amount` / `…Total` / `…Cost` / `…Price` and put `currency` beside them
  (`isMoneyField`): the Approvals and Audit pages then show them formatted
  instead of as raw cents. `diff(...)` keeps `currency` next to a changed
  amount.

## Multi-tenancy (business units)

- Every business table has a `businessUnitId: v.id("businessUnits")` field
  identifying which service it belongs to (`hair`, `fashion`, `housing`,
  `transport`), unless the table is truly global (e.g. shared
  reference/config data). Default to scoping by business unit; only omit it
  with a clear reason.
- Business units are seeded reference data (`convex/lib/businessUnits.ts`,
  `businessUnits` table); only Hair is enabled today. Locations (`locations`
  table: shop | warehouse) belong to one business unit and are never deleted
  — retire one with `active: false`.
- A user's own location is `users.locationId`. It is required for any user
  whose role has at least one `own_location` permission (enforced in
  `convex/users.ts`); that is what `own_location` scope checks compare
  against.

## Time

- The business time zone is **Africa/Lubumbashi (UTC+2)**. All day/week/month
  bucketing (reports, schedules, "today", etc.) is computed in that time
  zone, never in server-local or UTC-calendar terms.
- Timestamps are stored as **UTC milliseconds** (`number`); conversion to the
  business time zone happens at read/aggregation time, not at write time.

## Deletes

- Deletes of business data are never immediate. A delete goes through an
  **approval request** (soft delete): the record is flagged/queued, not
  removed, until an approver acts on it. Use the approval engine with type
  `"delete"` (see Approvals): the feature calls `requestApproval({ type:
  "delete", entityTable, entityId, payload: { before }, reason })`, and
  registers the table's delete handler in `DELETE_HANDLERS`
  (`convex/lib/approvalHandlers.ts`). That handler re-checks it's still
  safe to delete, removes the record, and audits a `delete` entry.
- Records that other records depend on (e.g. a product used in stock or a
  requisition) are **archived**, not deleted.

## Audit logging

- Every add, update, and delete writes an entry to the `auditLogs` table,
  in the same mutation as the change.
- Write entries only with `ctx.audit({...})` (inside `authedMutation`; the
  caller is the actor) or `logAudit(ctx, {...})` (`convex/lib/audit.ts`,
  for internal mutations). Actions go through
  `internal.auditLogs.insertFromActionInternal`.
- Entry shape: `action` (`create` | `update` | `delete` | `approve` |
  `reject`), `entityTable`, `entityId`, optional `businessUnitId`,
  `before` / `after` JSON snapshots, optional `reason`, `timestamp` (UTC ms).
  Creates log the full new record as `after`, deletes the full old record as
  `before`, and updates only the changed fields (use `diff(...)`; skip the
  entry when it returns null). Include readable fields (role key, location
  name) next to ids so the log is understandable on its own.
- **Never** put secrets (passwords, tokens) in a snapshot.
- The log is read on `/admin/audit`, gated by `audit.view`.

## Approvals

- Nobody can approve their own request (delete approvals or otherwise). The
  requester and the approver must always be different users — **except the
  Super Admin**, whose self-approvals are allowed and flagged in the audit
  log (`selfApproved: true`).
- There is **one** approval engine (`convex/lib/approvals.ts`,
  `convex/approvals.ts`). A feature never applies an approvable change
  directly: its mutation checks the caller may *request* it, then calls
  `requestApproval(ctx, { type, businessUnitId, locationId?, entityTable,
  entityId, payload, reason? })`. Never write `approvals.status` yourself —
  only `approvals.decideApproval` does, after checking the decider holds
  `requiredPermission` (in scope) and isn't the requester.
- The change is applied by the type's handler in `APPROVAL_HANDLERS`
  (`convex/lib/approvalHandlers.ts`), which runs in the same transaction as
  the decision: if it throws, nothing changes and the approval stays
  pending. Handlers audit what they change. A new approval type goes in
  `convex/lib/approvalTypes.ts` (the compiler then demands a handler and a
  default permission) plus `Approvals.types.<type>` in both message files.
- A type may also register an optional rejection hook in
  `APPROVAL_REJECTION_HANDLERS`, run in the same transaction when its
  approval is rejected. It is for **status bookkeeping only** (e.g. marking
  a requisition "rejected"), never for applying a change.
- Helpers that take an authed ctx use the `AuthedQueryCtx` /
  `AuthedMutationCtx` types from `convex/lib/rbac.ts`.
- Payload convention: `{ before?: {...}, after?: {...}, ...extra data the
  handler needs }` — the Approvals page shows `before`/`after` as a diff.
  Money inside it follows the Money rule (integer minor units + currency).
  Never put secrets in a payload.

## Inventory

- Stock is held by **holders** (`holders`: the business unit itself, a
  location, or a person). Sellable lots (`inventoryBatches`) are created
  **only** by receiving a purchase batch; their `unitCost` is the purchase
  unit cost (trip expenses are never spread into it).
- **Every quantity change goes through `applyMovement`**
  (`convex/lib/inventory.ts`): it takes from one holder, gives to the other,
  appends an `inventoryMovements` row and audits it, in the caller's
  mutation. It refuses to take a holder below zero — stock never goes
  negative. Nothing else inserts, patches or deletes `stockLevels` or
  `inventoryMovements` (a test scans the source for it).
- A change that needs approval (e.g. a distribution) checks availability
  when requested, and its handler moves stock through `applyMovement` on
  approval — if stock ran out meanwhile it throws and the approval stays
  pending.

## Sales

- A sale takes stock out of **one location** through `applyMovement`
  (type `"sale"`) in the same mutation that records it (`convex/sales.ts`):
  if the location doesn't hold enough, nothing is written. Convex
  serializes concurrent mutations, so two sellers can't sell the last unit.
- The location lock is the **scope** of `sales.create`: `own_location` =
  only the seller's own location (forced server-side); `all_locations` =
  anywhere (Chief Sales Admin, Super Admin). To let another role sell
  anywhere, grant it `sales.create` with "All locations" in Manage roles.
- Each line stores the lot's cost at sale time (`unitCostSnapshot`) and the
  product's suggested price (`suggestedPriceSnapshot`); margins are always
  computed from the snapshot, never from current costs. A price other than
  the suggested one needs a `discountReason`. Only `products.set_price`
  holders set suggested prices. Sales are USD only for now.
- A sale may be dated up to `MAX_BACKDATE_DAYS` (7) business days back,
  never in the future (`saleTimestamp`, `convex/lib/sales.ts`):
  `sales.createdAt` is when it happened (lists/filters use it),
  `recordedAt` when it was entered; backdated sales are flagged in the list
  and the audit. Stock still moves at recording time.

## Payroll & withdrawals

- Payroll entries (`convex/payroll.ts`) and withdrawals
  (`convex/withdrawals.ts`) are created `pending` and decided only through
  the approval engine (types `payroll` / `withdrawal`); the Chief Admin
  approves, never their own (Super Admin self-approval flagged). The scope
  of `payroll.create` / `withdrawals.request` locks the location, like
  sales (`convex/lib/locationScope.ts`).
- Salaries are private: without `payroll.view`, a submitter sees only the
  entries they submitted.
- **Withdrawals are never a business cost.** They live in their own table;
  any profit/analytics figure excludes them and shows them separately, so
  owners see the real picture.

## Analytics

- Analytics reads **pre-aggregated rollups only** — never scan raw sales
  for charts or totals. `dailyStats` (unit, locationKey, product, day:
  units, revenue, cost, margin) and `dailyFinance` (unit, locationKey,
  day: sales, saleCost, expenses, payroll, withdrawals), days in
  Africa/Lubumbashi, USD cents (`convex/lib/analytics.ts`).
- `applyRollupEvent(s)` is the **only** writer (a test scans the source).
  Every feature that changes money calls it **in the same mutation**,
  through an event builder (`saleEvents`, `expenseEvent`, `payrollEvent`,
  `withdrawalEvent`); add a builder for new sources. Each change goes to
  its location key (`"none"` for business-level) **and** to `"*"` (all
  locations). Voids and approved edits apply the reversed event (sign -1)
  then the new one.
- `computeRollups` is the single source of the arithmetic; the backfill
  `npx convex run analytics:rebuildRollups '{"businessUnitKey":"hair"}'`
  recomputes from raw data, and tests assert rollups == rebuild.
- Margin = sale price − purchase cost (`unitCostSnapshot`); net profit =
  margin − expenses − payroll; withdrawals are shown apart, never
  subtracted.

## Append-only tables

- Append-only tables — the audit log, inventory movements, and similar
  event-style tables — are **never** updated or deleted after being written.
  No function (public or internal) may patch, replace or delete their rows.
  `authedMutation`'s `ctx.db` rejects such writes at runtime (add new
  append-only tables to `APPEND_ONLY_RULES` in `convex/lib/rbac.ts`), and a
  test scans `convex/` source for them on `auditLogs`.
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

## App shell & navigation

- After login the first screen is the service picker (`/`). The selected
  service lives in the URL (`/[locale]/[service]/...`); `src/lib/
  service-store.ts` only remembers the last one for conveniences.
- Service modules are listed in `src/lib/shell-modules.ts`; the menu shows a
  module when the user holds any permission in its permission module. A new
  module page goes in a static folder `src/app/[locale]/[service]/<module>/`,
  which overrides the `[module]` placeholder route.
- Lists and tables use the shared `DataTable`
  (`src/components/data-table/`) — don't hand-roll `<table>` markup. Its
  features are opt-in per table: search, toolbar (filters/actions), per-column
  sorting, pagination (on by default: 10 / 20 / 50 rows per page, numbered
  pages for client data), expandable rows, responsive columns
  (`meta.hideBelow`) and a phone card layout (`renderCard`). Paginate Convex
  queries that take `paginationOpts` with `useCursorPaginatedQuery`; use the
  standalone `Pagination` component for paged content outside a table.
  Usage guide: `src/components/data-table/README.md`.
- Form fields the user must fill in use `<Label required>` (red star) on an
  input with the `required` attribute; optional fields have no star. Forms
  with several fields show `<RequiredFieldsHint />` ("* Required fields").
- UI is **mobile-first** — users work from phones. Design for ~360px wide
  first (tap targets ≥ 44px, no horizontal page scroll; wide tables scroll
  inside their own container or become cards on small screens).

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
  Convex function must go through the `convex/lib/rbac.ts` wrappers (built
  on `convex/lib/auth.ts`'s `requireCurrentUser` /
  `requireCurrentUserFromAction`), per the Permissions & security rule above.
- `users.isSuperAdmin` is **deprecated** (optional, never read or written);
  it was replaced by the Super Admin role. `rbac:seedRbac` backfills legacy
  flagged users onto that role. Managing users needs `users.manage`;
  assigning roles or editing role permissions needs `roles.manage`.

## Project layout

```
convex/
  schema.ts        # single source of truth for all tables
  auth.ts           # Convex Auth config (Password provider, callbacks)
  auth.config.ts    # required by Convex Auth (JWT provider)
  http.ts           # required by Convex Auth (auth HTTP routes)
  seed.ts           # bootstraps the first Super Admin from env vars
  rbac.ts           # roles/permissions: seedRbac, role editing, getMyPermissions
  businessUnits.ts  # the four services (seeded), list for the picker
  locations.ts      # shops/warehouses per business unit
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
(English/French) routing, authentication (Convex Auth, email +
password, admin-created accounts, block/unblock, forced password change),
RBAC (six seeded roles, permission catalog, Super Admin role editor at
`/admin/roles`, role assignment at `/admin/users`), business units and
locations (`/admin/locations`, user locations on `/admin/users`), and the
service picker + mobile-first app shell (`/hair` with placeholder module
pages), the append-only audit log (`/admin/audit`), the generic approval
engine (`/[service]/approvals`), the Hair product catalogue
(`/[service]/products`, with lengths/colours in `/[service]/settings`), and
requisitions (`/[service]/requisitions`: draft -> submit -> approve), and
stock batches (`/[service]/stock/batches`: purchasing abroad, trip expenses
kept aside (never spread into product costs) and addable at any time by the
buyer or the receiving team, approval, shipped/arrived), Goma receiving
(counting good/damaged/missing units into sellable lots), distributions to
locations/people with Chief Admin approval (`/[service]/stock/distributions`),
the inventory core with the stock overview by product, lot and holder
(`/[service]/stock`), and sales (`/[service]/sales`, the phone sale form at
`/[service]/sales/new`; suggested selling prices set on the price list at
`/[service]/products/prices`, next to each lot's purchase cost). Sale edits
and refunds come next), payroll (`/[service]/payroll`) and withdrawals
(`/[service]/withdrawals`), both approved by the Chief Admin, and the
analytics rollups + Analytics page (`/[service]/analytics`: sales, margin,
expenses, payroll, net profit, withdrawals apart, top products, charts).
Other business modules come in later steps, built on top
of the rules above.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
