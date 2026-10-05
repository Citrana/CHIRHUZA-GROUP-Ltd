# Improvement backlog

Findings from a full review of the platform (2 October 2026). Items are ordered by importance within each section. Tick them off as they're done.

What already works well: stock can't go negative, every change is audited, every approvable change goes through the one approval engine, and the server tests cover the core flows.

---

## 1. Fix soon (correctness and security)

### 1.1 The stock report ignores location limits
- **Where:** `productReport` and `productStockDetail` in `convex/inventory.ts`.
- **Problem:** both check `stock.view` but ignore its scope. Someone whose stock access is limited to their own location would still see every location's figures. No default role has `stock.view` at "own location" today, but CLAUDE.md requires location limits to be enforced on the server.
- **Fix:** for an `own_location` viewer, compute on-hand and the history from their own location's stock levels only (like `inventory.overview` already does), or refuse the query.

### 1.2 Filtered report pages can come back short
- **Where:** `productReport` (status "Never stocked", or a status combined with a search) and `statusCounts` in `convex/inventory.ts`.
- **Problem:** the query loads a page of products and then drops the ones that don't match the filter, so a page can show a few rows, or none, while more exist on later pages.
- **Also:** `statusCounts` re-reads up to 15,000 rows every time stock changes, which gets heavy as the catalogue grows.
- **Fix:** keep the per-status counts as counters updated by `applyMovement` (and when a threshold changes). For "never stocked", store a status on products, or index products by "has stock".

### 1.3 Rebuild commands must run in batches
- **Where:** `rebuildRollups` (`convex/lib/analytics.ts`) and `rebuildProductStock` (`convex/lib/inventory.ts`).
- **Problem:** each runs as a single operation and will exceed Convex's per-operation read/write limits once there's a lot of data.
- **Solution:** split along a natural boundary and process one piece per step; each step schedules the next with `ctx.scheduler.runAfter(0, …)`.
  - **Analytics, one business day per step:**
    1. delete that day's `dailyStats` and `dailyFinance` rows;
    2. recompute them from that day's sales, trip expenses, approved payroll and approved withdrawals (reusing `computeRollups`);
    3. schedule the next day.
  - **Product stock, one product per step** (or ~50 products): replay its movements (reusing `nextProductStock`) and rewrite its `productStock` row.
- **Why it's safe:** each piece is rebuilt in one transaction, and Convex runs transactions one after another. A sale recorded during the rebuild lands either before its day is rebuilt (and is counted) or after (and is applied normally). It's never lost or counted twice.
- **Needs:**
  - indexes for payroll by approval date and for trip expenses by service and date (today expenses are only reachable through their batch);
  - a small "rebuild run" record (current position, done/failed) and a progress query;
  - the same commands, which start a run and return straight away:
    - `npx convex run analytics:rebuildRollups '{"businessUnitKey":"hair"}'`
    - `npx convex run inventory:rebuildProductStock '{"businessUnitKey":"hair"}'`
- **Alternative considered:** the official Convex Migrations component. It walks through one table at a time, so it suits schema cleanups (see 3.5) better than these day-by-day and product-by-product rebuilds.

---

## 2. Business gaps (most valuable features)

### 2.1 Sale corrections, refunds and edits
A wrong sale can't be fixed today. The pieces already exist but nothing uses them:
- the `voided` sale status;
- the `sale_edit` approval type (its handler is `notImplementedYet`);
- reversed analytics events (`saleEvents(…, -1)`).

**Needs:**
- void or refund through an approval;
- stock returned to the shop through `applyMovement` (type "return");
- analytics reversed, audited.

### 2.2 Stock corrections
The movement types `adjustment`, `transfer` and `return` exist, but nothing uses them yet.

**Needs:**
- **adjustments** after a physical count (with a reason and approval);
- **transfers** between shops or people;
- **returns** to the warehouse.

### 2.3 Credit tracking ✅ done
Built: customer list, agreed total per sale, part payment at the sale, repayments (oldest sale first), corrections through approval, Credit page. Originally: credit sales only recorded the customer's name.

**Needs:**
- a "who owes what" list per customer;
- recording repayments;
- each customer's balance.

### 2.4 Francs (CDF)
Sales, payroll and withdrawals are USD only, while much daily cash in Goma is CDF.

**Needs:**
- a daily exchange rate;
- sales and payments in CDF, each storing the rate used;
- analytics converted to one reporting currency.

### 2.5 General expenses module
- **Problem:** the "Expenses" menu item still opens an empty placeholder (the `expense` approval type is `notImplementedYet`). Analytics only counts purchase-trip expenses, so net profit is overstated.
- **Needs:** rent, electricity, local transport and similar costs, per location, with approval, fed into `dailyFinance.expenses`.

### 2.6 Sale receipts
A receipt to print or share on WhatsApp after each sale (number, items, total, shop, date).

### 2.7 Approval alerts
The Chief Admin has to open Approvals to see what's waiting. Add notifications for pending approvals: a daily email or WhatsApp summary at least, or instant alerts.

### 2.8 A useful Home page
Today's sales, pending approvals, and low or out-of-stock products, on each service's Home page (currently a placeholder).

### 2.9 Selling while offline
Sellers on weak connections can't record sales. This is the largest item here. First decide whether it's really needed (it means queuing sales on the phone and syncing later, with stock checks at sync time).

---

## 3. Reliability and security

- **3.1 Security headers:** `next.config.ts` sets none. Add a content security policy and protection against embedding in other sites (`X-Frame-Options` / `frame-ancestors`), plus `Referrer-Policy` and `X-Content-Type-Options`.
- **3.2 Error monitoring:** nothing alerts you when something fails in production. Add error tracking (e.g. Sentry) for the web app and Convex functions.
- **3.3 Backups:** confirm Convex backups are scheduled, and test a restore once.
- **3.4 Browser tests:** all tests cover the server only. Add one automated walkthrough (e.g. Playwright) of the sale form and the approval flow.
- **3.5 Remove retired fields** with a one-time cleanup: `locations.businessUnitId`, `stockBatches.allocationMethod` and `users.isSuperAdmin`.

---

## 4. Polish

- **4.1 Audit log names:** only users, roles and locations have readable names (`Admin.audit.entities` in the message files). Sales, products, batches, distributions and the rest show raw table names.
- **4.2 Stock report CSV:** the download ignores the search box. It only applies the status filter.
- **4.3 CLAUDE.md:**
  - "Current status" has an unbalanced bracket ("…Sale edits and refunds come next), payroll…");
  - the project layout still describes `locations.ts` as "shops/warehouses per business unit" (locations are now shared by every service).

---

## Suggested order
1. The three "Fix soon" items (1.1–1.3), in one small change.
2. Sale corrections and refunds (2.1), and stock corrections (2.2). They protect the accuracy of stock, analytics and profit.
3. Then, by business priority: general expenses (2.5), credit tracking (2.3), francs (2.4).
