# Deployment and environments

How the platform is deployed, what was set up and when, and the commands to run it day to day. Last updated 4 October 2026.

Related docs:
- `docs/improvements.md`: the improvement backlog from the full review.
- `docs/training/`: the staff training guide (v01, English and French PDFs), with a README on how to rebuild it.

---

## 1. The setup at a glance

| | Dev (your laptop) | Prod (real data) |
|---|---|---|
| Convex deployment | `fearless-chickadee-48` | `mellow-buzzard-580` |
| Convex URL | `https://fearless-chickadee-48.convex.cloud` | `https://mellow-buzzard-580.convex.cloud` |
| Website | `http://localhost:3000` (`pnpm dev`) | `https://chirhuza-group-ltd.vercel.app` |
| Hosting | — | Vercel, Hobby (free) plan, project `chirhuza-group-ltd` |
| Data | Test data only | Real business data |
| Super Admin | Baraka Danny | Baraka Danny, `barakadan421@gmail.com` |

**Hobby plan:** Vercel's Hobby plan is for non-commercial use. It's fine for the test period. Move to Vercel Pro (about $20/month) when the domain is bought and the business relies on the platform.

**The domain changes nothing in the data.** All data lives in Convex. Buying a domain only changes where the website is served from (see section 6).

---

## 2. Which commands touch which database

Locally, `.env.local` points at **dev**:
```
CONVEX_DEPLOYMENT=dev:fearless-chickadee-48
NEXT_PUBLIC_CONVEX_URL=https://fearless-chickadee-48.convex.cloud
```

| Command | Database |
|---|---|
| `pnpm dev`, `npx convex dev` | dev |
| `npx convex run …`, `npx convex env …`, `npx convex export …` | dev |
| `pnpm test` | neither (in-memory test database) |
| Any command with `--prod` | **prod** |
| `npx convex deploy` | **prod**, always |

**Be careful with:**
- anything with `--prod`;
- `npx convex deploy`;
- **never** `npx convex import --replace-all --prod` unless you mean to wipe production.

---

## 3. How a release goes live

Every push or merge to **`develop`** deploys automatically, in 2–4 minutes:
1. Vercel sees the new commit on `develop` and starts a build.
2. The build command `npx convex deploy --cmd 'pnpm run build'`:
   - updates the prod Convex functions and schema, using `CONVEX_DEPLOY_KEY`;
   - builds the website, with `NEXT_PUBLIC_CONVEX_URL` filled in automatically.
3. The new version goes live; users see it on their next page load.

If the build fails, nothing changes and the previous version stays live.

**Planned improvement:** a separate `main` branch for releases.
- Set Vercel **Settings → Environments → Production → Branch** to `main`.
- Keep merging features into `develop`; merge `develop` into `main` to release.
- Turn off automatic preview builds in **Settings → Git**. Preview builds would fail anyway, because the deploy key is Production-only.

---

## 4. What was set up (2–3 October 2026)

### 4.1 Convex prod
Run from the repo root, in this order:
```sh
npx convex deploy                      # first push of functions + schema to prod
npx @convex-dev/auth --prod            # SITE_URL, JWT_PRIVATE_KEY, JWKS for prod
npx convex env set --prod SUPER_ADMIN_NAME 'Baraka Danny'
npx convex env set --prod SUPER_ADMIN_EMAIL '…'
npx convex env set --prod SUPER_ADMIN_PASSWORD '…'
npx convex run --prod seed:seedSuperAdmin          # Super Admin + roles, permissions, services
npx convex run --prod businessUnits:setEnabled '{"key":"hair","enabled":true}'
npx convex run --prod businessUnits:setEnabled '{"key":"fashion","enabled":true}'
npx convex env remove --prod SUPER_ADMIN_PASSWORD  # never leave the password in settings
```

**Super Admin email change.** The account was first created with the wrong email and was corrected by hand in the Convex dashboard (Production → Data). The app has no "change email" feature, and the email lives in two places, which must match:
- `users.email`;
- `authAccounts.providerAccountId` (the sign-in email).

`SUPER_ADMIN_EMAIL` was then updated to `barakadan421@gmail.com`. That variable is only read when the first Super Admin is created.

**Prod environment variables** (the names, not the values):
- `SITE_URL`
- `JWT_PRIVATE_KEY`, `JWKS`
- `SUPER_ADMIN_NAME`, `SUPER_ADMIN_EMAIL`

### 4.2 Deploy key
- Created in the Convex dashboard (**Production → Settings → Deploy Keys → Create Deploy Key**), named `vercel`, with no expiration.
- It has **only** the `deployment:deploy` permission: Vercel only needs to push code. If the key leaked, it couldn't read data, change settings or download backups.
- If a Vercel build ever fails with a Convex permission error, create a new key with the extra permission it names, and replace it in Vercel.

### 4.3 Vercel project
- Imported from GitHub `Citrana/CHIRHUZA-GROUP-Ltd`, branch `develop`. The Hobby plan accepted the organization repo.
- **Framework:** Next.js; **root directory:** `./`.
- **Build Command (override on):** `npx convex deploy --cmd 'pnpm run build'`
- **Install Command, Output Directory:** defaults.
- **Environment variable:** `CONVEX_DEPLOY_KEY` (sensitive), **Production only**.
- The optional "Convex" integration Vercel offers was **not** added: it would create a second, empty Convex database.

### 4.4 Site URL
```sh
npx convex env set --prod SITE_URL 'https://chirhuza-group-ltd.vercel.app'
```

---

## 5. Still to do

- [ ] Check the live site end to end:
  - sign in;
  - EN and FR;
  - add the real locations;
  - create a real user and test their first sign-in and password change;
  - open Products, Stock, Approvals and Analytics.
- [ ] Backups:
  - in the Convex dashboard (Production → **Settings → Backup & Restore**), click **Backup Now**, and turn on scheduled backups if the plan offers them;
  - also keep a weekly copy off the laptop:
    ```sh
    npx convex export --prod --include-file-storage --path chiruza-prod-backup-$(date +%F).zip
    ```
- [ ] Add security headers before wider use (`docs/improvements.md`, 3.1).
- [ ] Decide on a `main` release branch (section 3).
- [ ] Give the China buyer an account with the **Chief Inventory Admin** role (Administrateur en chef de l'inventaire). They work in **Stock → Purchase batches**; see chapter 6 of the training guide.

---

## 6. When the domain is bought

1. Move Vercel to Pro.
2. **Vercel → Settings → Domains:** add the domain, then add the DNS records Vercel shows at your domain provider.
3. Point Convex at the new address:
   ```sh
   npx convex env set --prod SITE_URL 'https://your-domain.com'
   ```
4. Users sign in once more on the new address (logins are saved per address). Accounts, passwords and all data stay the same.

No data moves: the Convex prod deployment stays `mellow-buzzard-580`.

---

## 7. Day-to-day reminders

- When a change adds new permissions (a new `SEED_STEPS` entry), run this after it's deployed:
  ```sh
  npx convex run --prod seed:seedReferenceData
  ```
- Rebuild commands on prod:
  ```sh
  npx convex run --prod analytics:rebuildRollups '{"businessUnitKey":"hair"}'
  npx convex run --prod inventory:rebuildProductStock '{"businessUnitKey":"hair"}'
  ```
  These still run as one big operation. Batch them before the data grows (`docs/improvements.md`, 1.3).
- Watch usage on the Convex free plan: database size, file storage (Mode photos, receipts) and function calls.

### If something goes wrong

| What you see | Fix |
|---|---|
| Vercel build: "CONVEX_DEPLOY_KEY is not set" | Key missing or not ticked for Production; add it and redeploy |
| Vercel build fails about pnpm or the lockfile | Add the env var `ENABLE_EXPERIMENTAL_COREPACK` = `1` and redeploy |
| Convex permission error during the build | The deploy key needs another permission (section 4.2) |
| Site loads but sign-in fails | Check `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` on prod, and that the user exists |
| Signed-in user sees no services | Run the `businessUnits:setEnabled` commands with `--prod` |

---

## 8. Dev database reset (2 October 2026)

All test data was removed from dev. Kept:
- the one user (Baraka Danny), with their account and sessions;
- roles, permissions and role permissions;
- applied seed steps, business units and locations.

Everything else was emptied, including file storage. A backup taken first is at `../chiruza-dev-backup-2026-10-02.zip` (next to the repo folder).

**Method, to repeat it:**
1. `npx convex export --include-file-storage --path backup.zip`
2. Filter the tables to keep into a new zip.
3. `npx convex import --replace-all -y clean.zip`
