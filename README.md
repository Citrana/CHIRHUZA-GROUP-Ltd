# CHIRHUZA GROUP Ltd

A multi-service business management platform covering four business units:
**hair, fashion, housing, transport**.

Stack: [Next.js](https://nextjs.org) (App Router) · TypeScript (strict) ·
Tailwind CSS · [shadcn/ui](https://ui.shadcn.com) · [Convex](https://convex.dev) ·
[next-intl](https://next-intl.dev) (English/French)

See [CLAUDE.md](./CLAUDE.md) for the permanent rules this codebase follows
(permissions, money handling, multi-tenancy, time zones, deletes, audit
logging, i18n, testing).

## Getting started

Install dependencies:

```bash
pnpm install
```

Connect Convex (first time only — logs you in, links/creates a deployment,
and writes `NEXT_PUBLIC_CONVEX_URL` into `.env.local`). Leave it running in
its own terminal tab while you develop, since it also pushes function
changes live:

```bash
pnpm dlx convex dev
```

Once it has pushed, open a second terminal and seed the reference data
(roles, permissions and business units):

```bash
pnpm dlx convex run seed:seedReferenceData
```

Then, in that same second terminal, run the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) — it redirects to
`/en` (or `/fr`) and then to `/login`. On a brand-new deployment, finish
[Authentication setup](#authentication-setup-first-time-only) first.

## After pulling changes

Whenever you pull or switch branches, and `pnpm dlx convex dev` is running
(so the latest schema and functions are pushed), re-run the seed:

```bash
pnpm dlx convex run seed:seedReferenceData
```

It is safe to run any number of times: it only adds missing permissions,
roles and business units, and never undoes changes made in the Roles UI.
Skipping it is the usual reason a new page or menu link doesn't appear —
the permission that unlocks it hasn't been created yet.

If product search misses products by length or colour (e.g. after an update
that changed what search covers), rebuild the product search text. It's
also safe to re-run:

```bash
pnpm dlx convex run products:rebuildSearchText
```

## Authentication setup (first time only)

Auth is Convex Auth (email + password, no public sign-up — only a Super
Admin creates accounts). Two one-time steps on a fresh deployment:

1. Generate a JWT keypair and set it as Convex deployment env vars (not
   `.env.local` — this is server-side only):
   ```bash
   node -e "
   import('jose').then(async ({ exportJWK, exportPKCS8, generateKeyPair }) => {
     const keys = await generateKeyPair('RS256', { extractable: true });
     const privateKey = await exportPKCS8(keys.privateKey);
     const publicKey = await exportJWK(keys.publicKey);
     console.log('JWT_PRIVATE_KEY=\"' + privateKey.trimEnd().replace(/\n/g, ' ') + '\"');
     console.log('JWKS=' + JSON.stringify({ keys: [{ use: 'sig', ...publicKey }] }));
   })"
   # pipe/paste the two output lines into a file, then:
   pnpm dlx convex env set --from-file <that file>
   pnpm dlx convex env set SITE_URL "http://localhost:3000"
   ```
2. Bootstrap the first Super Admin:
   ```bash
   pnpm dlx convex env set SUPER_ADMIN_NAME "Your Name"
   pnpm dlx convex env set SUPER_ADMIN_EMAIL "you@example.com"
   pnpm dlx convex env set SUPER_ADMIN_PASSWORD "a strong password"
   pnpm dlx convex run seed:seedSuperAdmin
   ```
   This also seeds the reference data, and no-ops if a Super Admin already
   exists. Log in at `/login` with those credentials, then:
   - **Locations** — add the shops and warehouses (Sales Agents need one).
   - **Manage users** — create further accounts and give each a role.

## Scripts

```bash
pnpm dev      # start the Next.js dev server
pnpm build    # production build
pnpm lint     # ESLint
pnpm test     # Vitest (Convex function tests via convex-test)
```

Convex commands:

```bash
pnpm dlx convex dev                          # push schema + functions live (keep running)
pnpm dlx convex run seed:seedReferenceData   # seed roles, permissions, business units (idempotent)
pnpm dlx convex run seed:seedSuperAdmin      # first Super Admin (see Authentication setup)
pnpm dlx convex run products:rebuildSearchText # recompute product search text (idempotent)
pnpm dlx convex dashboard                    # open the deployment's dashboard
pnpm dlx convex data <table>                 # print a table's rows, e.g. `auditLogs`
```

Before considering any change done, these should all pass:

```bash
pnpm lint
pnpm exec tsc --noEmit             # app types
pnpm exec tsc --noEmit -p convex   # Convex function types
pnpm test
```

## Branching & commits

`pnpm install` sets up git hooks automatically (via Husky). Every commit
runs a `pre-commit` check that:

1. Validates the current branch name against `<type>/<kebab-case-description>`
   (types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test` — e.g.
   `feat/add-login-page`). `main` and `develop` are exempt.
2. Runs `pnpm test`. Any failing test blocks the commit; Vitest prints a
   full pass/fail report per test file in the terminal.

## Project layout

```
convex/
  schema.ts        # single source of truth for all tables
  auth.ts           # Convex Auth config (Password provider, callbacks)
  seed.ts           # seedReferenceData + bootstraps the first Super Admin
  rbac.ts           # roles & permissions
  businessUnits.ts  # the four services
  locations.ts      # shops & warehouses
  auditLogs.ts      # read-only audit log queries
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

## Status

In place: project setup, English/French i18n, authentication (Convex Auth,
admin-created accounts, block/unblock, forced password change), roles &
permissions (`/admin/roles`), business units and locations
(`/admin/locations`), the service picker and mobile-first Hair app shell,
and the append-only audit log (`/admin/audit`). Business modules (sales,
stock, …) are placeholders for now.
