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

In a second terminal, run the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) — it redirects to
`/en` (or `/fr`). You should see "CHIRHUZA GROUP Ltd" and a "Convex
connected" status badge once both are running.

## Scripts

```bash
pnpm dev      # start the Next.js dev server
pnpm build    # production build
pnpm lint     # ESLint
pnpm test     # Vitest (Convex function tests via convex-test)
```

Before considering any change done, `pnpm lint`, `pnpm exec tsc --noEmit`,
and `pnpm test` should all pass.

## Project layout

```
convex/
  schema.ts        # single source of truth for all tables
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

Scaffold stage: project setup, Convex connection, folder structure, and
English/French i18n are in place. No auth, roles, or business features yet.
