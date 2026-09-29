# DataTable

The shared table for every list in the app. Features are **opt-in per
table**: turn on only what a list needs. Don't hand-roll `<table>` markup
(see CLAUDE.md).

Built on [TanStack Table](https://tanstack.com/table) **v9**. Its API
differs from v8, so v8 docs and most shadcn "data table" examples
(`useReactTable`, `getCoreRowModel`, …) don't apply here.

## What's here

| File | What it is |
|---|---|
| `data-table.tsx` | `DataTable`: the table component. |
| `features.ts` | `dataTableFeatures`: the TanStack v9 features every DataTable registers. Also `DataTableColumn<Row>` (the column type) and `DataTableColumnMeta`. |
| `pagination.tsx` | `Pagination`: Prev / Next + rows-per-page bar. Used by DataTable, and usable on its own. |
| `data-table-search.tsx` | `DataTableSearch`: debounced search box used by DataTable. |
| `use-cursor-paginated-query.ts` | `useCursorPaginatedQuery`: page-by-page view of a Convex paginated query. |
| `cursor-pagination.ts` | Pure cursor-stack logic behind the hook (unit-tested). |

## Quick start

```tsx
"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";

type ProductRow = FunctionReturnType<typeof api.products.list>[number];

export function ProductsTable() {
  const t = useTranslations("Products");
  const products = useQuery(api.products.list); // undefined while loading

  const columns: DataTableColumn<ProductRow>[] = [
    { accessorKey: "name", header: t("nameHeader"), enableSorting: true },
    { accessorKey: "sku", header: t("skuHeader"), meta: { hideBelow: "md" } },
  ];

  return (
    <DataTable
      columns={columns}
      data={products}
      getRowId={(p) => p._id}
      emptyMessage={t("empty")}
    />
  );
}
```

That gives a styled table with loading and empty states, which scrolls
sideways inside its own box on narrow screens. Add the features below as
needed.

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `columns` | `DataTableColumn<Row>[]` | required | Column definitions (see [Columns](#columns)). |
| `data` | `Row[] \| undefined` | required | The rows. `undefined` shows "Loading…". Pass `useQuery`'s result straight through. |
| `getRowId` | `(row) => string` | required | Stable id per row (normally `row._id`). Used for keys and expansion. |
| `emptyMessage` | `string` | "No results." | Shown when there are no rows. Also shown when a search matches nothing. |
| `search` | `{ placeholder?, value?, onChange? }` | off | Shows a search box. **Without `onChange`:** filters the loaded rows client-side. **With `value` + `onChange`:** you own the text and filter on the server (pass it to your query). |
| `toolbar` | `ReactNode` | none | Filters or actions shown beside the search box. Wraps on phones. |
| `pagination` | `{ mode: "client", pageSize?, pageSizeOptions? }` or `{ mode: "server", ...PaginationProps }` | off | See [Pagination](#pagination). |
| `initialSorting` | `SortingState` | `[]` | e.g. `[{ id: "name", desc: false }]`. |
| `renderExpanded` | `(row) => ReactNode` | off | Makes rows clickable. A click, Enter or Space toggles this detail view under the row. |
| `renderCard` | `(row) => ReactNode` | off | On phones (below `md`) renders one card per row instead of the table. |
| `className` | `string` | none | Classes for the outer wrapper. |

## Columns

Columns are TanStack v9 column definitions typed as `DataTableColumn<Row>`.

```tsx
const columns: DataTableColumn<UserRow>[] = [
  // Plain field. Searchable, and sortable because it opts in.
  { accessorKey: "name", header: t("nameHeader"), enableSorting: true },

  // Computed/translated value: use accessorFn, so search and sorting
  // work on the text the user actually sees.
  {
    id: "type",
    accessorFn: (loc) => (loc.type === "shop" ? t("typeShop") : t("typeWarehouse")),
    header: t("typeHeader"),
    enableSorting: true,
  },

  // Custom rendering. `row.original` is your row object.
  {
    accessorKey: "status",
    header: t("statusHeader"),
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },

  // Display-only column (no value): not searchable, not sortable.
  // A function header lets you keep the label for screen readers only.
  {
    id: "actions",
    header: () => <span className="sr-only">{t("actionsHeader")}</span>,
    cell: ({ row }) => <EditButton row={row.original} />,
    meta: { className: "text-right" },
  },
];
```

- **Sorting is opt-in:** add `enableSorting: true` to a column. Clicking
  its header toggles ascending/descending. It applies to client data only;
  server data arrives in the order the query returns.
- **Search** matches text/number values of columns with an `accessorKey`
  or `accessorFn`. Display-only columns are ignored.
- **`meta.hideBelow: "sm" | "md" | "lg"`** hides a column on narrower
  screens. Use it for secondary columns (email, IDs, addresses).
- **`meta.className`** adds classes to that column's header and body
  cells (alignment, `whitespace-nowrap`, widths).

## Pagination

### Client (`mode: "client"`)

For lists that are loaded in full (hundreds of rows at most): users,
locations, roles.

```tsx
<DataTable
  columns={columns}
  data={users}
  getRowId={(u) => u._id}
  search={{ placeholder: t("searchPlaceholder") }}
  pagination={{ mode: "client", pageSize: 10 }}
  initialSorting={[{ id: "name", desc: false }]}
/>
```

The pager shows "Showing 1–10 of 42". It hides itself when everything fits
on one page. Searching goes back to page 1. Live data updates (e.g. after
editing a row) keep you on the current page. If that page stops existing,
the table steps back to the last one.

### Server (`mode: "server"`), for large or growing tables

For tables that can grow without limit (audit log, sales, stock
movements), page on the server with Convex cursor pagination.

**1. The Convex query** takes `paginationOpts`, uses `.paginate()`, and
still checks permissions:

```ts
import { paginationOptsValidator } from "convex/server";

export const list = authedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(v.string()), // any filters
  },
  handler: async (ctx, args) => {
    await ctx.requirePermission("sales.view");
    return await ctx.db
      .query("sales")
      .withIndex("by_timestamp")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
```

**2. The component** uses `useCursorPaginatedQuery` and passes its
`pagination` through:

```tsx
const { results, pagination } = useCursorPaginatedQuery(
  api.sales.list,
  canView ? { status } : "skip",   // args without paginationOpts
  { initialPageSize: 25 },
);

<DataTable
  columns={columns}
  data={results}
  getRowId={(s) => s._id}
  pagination={{ mode: "server", ...pagination }}
/>
```

- Changing the args (filters) or the page size **goes back to page 1**.
- While the next page loads, the current one stays on screen.
- Cursor pagination has **no grand total**: the pager shows "Showing
  26–50 · Page 2", with no "of N".

### Standalone `Pagination`

For paged content that isn't a table (e.g. a card grid), render
`<Pagination {...pagination} />` directly. It takes the same props that
`useCursorPaginatedQuery` returns.

## Recipes

### Expandable rows

```tsx
<DataTable
  columns={columns}
  data={results}
  getRowId={(e) => e._id}
  renderExpanded={(entry) => <EntryDetails entry={entry} />}
/>
```

Rows become clickable and keyboard-toggleable (Enter/Space), with a
chevron and `aria-expanded`. Clicks on **buttons, links, inputs and
selects inside a row don't toggle it**, so row actions keep working.

Keep the row itself to one line and put the detail in `renderExpanded`.
See the audit log (`src/components/admin/audit-log-panel.tsx`).

### Phone cards

```tsx
<DataTable
  columns={columns}
  data={locations}
  getRowId={(l) => l._id}
  renderCard={(location) => (
    <div className="flex flex-col gap-2">
      <p className="font-medium">{location.name}</p>
      <p className="text-sm text-muted-foreground">{location.address}</p>
      <EditButton location={location} />
    </div>
  )}
/>
```

Below `md` the cards replace the table. Search, sorting, pagination and
`renderExpanded` all still apply to them. Without `renderCard`, phones get
the table with horizontal scroll, so use `meta.hideBelow` to keep it
narrow.

### Filters in the toolbar

```tsx
<DataTable
  columns={columns}
  data={results}
  getRowId={(r) => r._id}
  pagination={{ mode: "server", ...pagination }}
  toolbar={
    <div className="flex flex-col gap-1.5 sm:w-56">
      <Label htmlFor="status-filter">{t("statusLabel")}</Label>
      <NativeSelect id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
        …
      </NativeSelect>
    </div>
  }
/>
```

Keep filter state in the page, and feed it into the query args (server) or
filter `data` before passing it in (client). With many filters, fold them
behind a toggle button on phones, as the audit log does.

## Rules

- **Mobile-first.** Check every table at ~360px wide. Give it
  `renderCard`, or keep it narrow with `meta.hideBelow`. Tap targets stay
  at least 44px.
- **Every string is translated.** Headers, placeholders and empty messages
  come from `messages/en.json` + `messages/fr.json`. DataTable's own labels
  (search, pagination, loading) live in the `DataTable` namespace.
- **The table is not security.** Hiding a column or skipping a query only
  affects the UI. The Convex query must enforce permissions itself
  (`authedQuery` + `ctx.requirePermission`), per CLAUDE.md.
- **Skip queries the user can't run** (`canView ? args : "skip"`). Don't
  let them throw.
- **Server tables need an index** that matches their sort order and main
  filters (see `convex/auditLogs.ts` for one that picks between several
  indexes).

## Extending DataTable

New capabilities go into DataTable **as opt-in props, off by default**, so
existing tables don't change.

1. If it needs a TanStack feature, register it in `features.ts`. In v9 a
   feature's state and methods **don't exist until the feature is
   registered**; a "missing" API usually means this step was skipped. Row
   models go in their slot after their feature, e.g. `rowSelectionFeature`,
   or `rowExpandingFeature` + `expandedRowModel: createExpandedRowModel()`.
2. Add the prop to `DataTableProps` with a short doc comment, and wire it
   in `data-table.tsx`.
3. Add any new labels to the `DataTable` namespace in **both** message
   files.
4. Update this README.

For the installed TanStack v9 API, read
`node_modules/@tanstack/react-table/skills/` (bundled usage guides) and the
type declarations in `node_modules/@tanstack/react-table/dist/`.
