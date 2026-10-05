"use client";

import {
  Fragment,
  useCallback,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  flexRender,
  useTable,
  type PaginationState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import {
  dataTableFeatures,
  type DataTableColumn,
} from "@/components/data-table/features";
import {
  DEFAULT_PAGE_SIZE,
  Pagination,
  type PaginationProps,
} from "@/components/data-table/pagination";
import { cn } from "@/lib/utils";

// Stable empty fallback: a fresh `[]` each render would invalidate the
// table's data-dependent models every render.
const NO_ROWS: never[] = [];

// Literal strings so Tailwind generates them.
const HIDE_BELOW = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

export type DataTablePagination =
  | { mode: "client"; pageSize?: number; pageSizeOptions?: readonly number[] }
  | ({ mode: "server" } & PaginationProps);

export type DataTableProps<TData extends RowData> = {
  columns: DataTableColumn<TData>[];
  /** `undefined` while loading. */
  data: TData[] | undefined;
  getRowId: (row: TData) => string;
  emptyMessage?: string;
  /**
   * Show a search box. Without `onChange` it filters the loaded rows
   * (client-side); with `onChange` the caller owns the value and filtering
   * (e.g. passes it to a Convex query).
   */
  search?: {
    placeholder?: string;
    value?: string;
    onChange?: (value: string) => void;
  };
  /** Extra filters / actions shown beside the search box. */
  toolbar?: ReactNode;
  /**
   * On by default: omitted = `{ mode: "client" }` (pages the loaded rows,
   * 10 per page). `server`: rows are already one page (e.g. from
   * useCursorPaginatedQuery); pass its `pagination`. `false` turns
   * pagination off.
   */
  pagination?: DataTablePagination | false;
  initialSorting?: SortingState;
  /** Clicking a row toggles this detail view underneath it. */
  renderExpanded?: (row: TData) => ReactNode;
  /**
   * Clicking (or Enter/Space on) a row calls this - e.g. to open a detail
   * drawer. Takes precedence over `renderExpanded`; use one or the other.
   */
  onRowClick?: (row: TData) => void;
  /** On phones (< md), show these cards instead of the table. */
  renderCard?: (row: TData) => ReactNode;
  className?: string;
};

/** Clicks on controls inside a row shouldn't also expand the row. */
function isFromInteractive(event: MouseEvent | KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  const interactive = target.closest(
    "a, button, input, select, textarea, label, [role=button], [role=menuitem]",
  );
  return interactive !== null && interactive !== event.currentTarget;
}

/**
 * The shared table for lists across the app. Every feature is opt-in:
 * search, toolbar, sorting (per column via `enableSorting`), client or
 * server pagination, expandable rows, responsive columns and a phone card
 * layout. Mobile-first: wide tables scroll inside their own container.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  emptyMessage,
  search,
  toolbar,
  pagination,
  initialSorting = [],
  renderExpanded,
  onRowClick,
  renderCard,
  className,
}: DataTableProps<TData>) {
  const t = useTranslations("DataTable");
  // Inline expansion only applies when rows don't open something else.
  const renderInline = onRowClick ? undefined : renderExpanded;
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [clientSearch, setClientSearch] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Every table paginates unless it opts out with `pagination={false}`.
  const paging: DataTablePagination | null =
    pagination === false ? null : (pagination ?? { mode: "client" });
  const clientPaging = paging?.mode === "client";
  const [pageState, setPageState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize:
      paging?.mode === "client"
        ? (paging.pageSize ?? DEFAULT_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE,
  });
  const searchIsServer = search?.onChange !== undefined;
  const changeClientSearch = useCallback((value: string) => {
    setClientSearch(value);
    setPageState((prev) => ({ ...prev, pageIndex: 0 }));
  }, []);

  const table = useTable({
    features: dataTableFeatures,
    data: data ?? (NO_ROWS as TData[]),
    columns,
    getRowId: (row) => getRowId(row),
    state: {
      sorting,
      globalFilter: searchIsServer ? "" : clientSearch,
      pagination: pageState,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: changeClientSearch,
    onPaginationChange: setPageState,
    // Convex data updates live (e.g. after editing a row); TanStack's default
    // would then jump back to page 1. Only a new search resets the page.
    autoResetPageIndex: false,
    globalFilterFn: "includesString",
    // Server pages (and unpaginated tables) arrive ready to show as-is.
    manualPagination: !clientPaging,
    enableSortingRemoval: false,
    // Sorting is opt-in per column (`enableSorting: true`).
    defaultColumn: { enableSorting: false },
  });

  // If rows disappear (e.g. deleted elsewhere) and this page no longer
  // exists, step back to the last page that does.
  const pageCount = clientPaging ? table.getPageCount() : 0;
  if (clientPaging && pageState.pageIndex > 0 && pageState.pageIndex >= pageCount) {
    setPageState((prev) => ({ ...prev, pageIndex: Math.max(pageCount - 1, 0) }));
  }

  const rows = table.getRowModel().rows;
  const colSpan =
    table.getAllLeafColumns().length + (renderInline ? 1 : 0);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rowsAreClickable = onRowClick !== undefined || renderExpanded !== undefined;

  const rowHandlers = (id: string, original: TData) => {
    if (!rowsAreClickable) return {};
    const activate = () => (onRowClick ? onRowClick(original) : toggle(id));
    return {
      role: "button" as const,
      tabIndex: 0,
      ...(onRowClick ? {} : { "aria-expanded": expanded.has(id) }),
      onClick: (e: MouseEvent) => {
        if (!isFromInteractive(e)) activate();
      },
      onKeyDown: (e: KeyboardEvent) => {
        if ((e.key === "Enter" || e.key === " ") && !isFromInteractive(e)) {
          e.preventDefault();
          activate();
        }
      },
    };
  };


  let paginationProps: PaginationProps | null = null;
  if (paging?.mode === "server") {
    paginationProps = paging;
  } else if (paging?.mode === "client") {
    const total = table.getFilteredRowModel().rows.length;
    const { pageIndex, pageSize } = pageState;
    const start = total === 0 ? 0 : pageIndex * pageSize + 1;
    paginationProps = {
      page: pageIndex + 1,
      canPrevious: table.getCanPreviousPage(),
      canNext: table.getCanNextPage(),
      onPrevious: () => table.previousPage(),
      onNext: () => table.nextPage(),
      pageSize,
      pageSizeOptions: paging.pageSizeOptions,
      onPageSizeChange: (size) => table.setPageSize(size),
      rangeStart: start,
      rangeEnd: total === 0 ? 0 : start + rows.length - 1,
      totalCount: total,
      pageCount: Math.max(pageCount, 1),
      onPageChange: (page) => table.setPageIndex(page - 1),
    };
  }
  // Shown whenever there are rows, so the rows-per-page choice is always
  // reachable (and on an emptied later page, to get back).
  const showPagination =
    paginationProps !== null && (rows.length > 0 || paginationProps.canPrevious);

  const status =
    data === undefined ? t("loading") : rows.length === 0 ? (emptyMessage ?? t("noResults")) : null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {search || toolbar ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          {search ? (
            <DataTableSearch
              value={searchIsServer ? (search.value ?? "") : clientSearch}
              onChange={search.onChange ?? changeClientSearch}
              placeholder={search.placeholder}
            />
          ) : null}
          {toolbar}
        </div>
      ) : null}

      {renderCard ? (
        <ul className="flex flex-col gap-3 md:hidden">
          {status ? (
            <li className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {status}
            </li>
          ) : (
            rows.map((row) => (
              <li
                key={row.id}
                className={cn(
                  "rounded-lg border border-border bg-card p-4",
                  rowsAreClickable &&
                    "cursor-pointer focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                )}
                {...rowHandlers(row.id, row.original)}
              >
                {renderCard(row.original)}
                {renderInline && expanded.has(row.id) ? (
                  <div className="mt-3 border-t border-border pt-3">
                    {renderInline(row.original)}
                  </div>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}

      <div
        className={cn(
          "overflow-x-auto rounded-lg border border-border",
          renderCard && "hidden md:block",
        )}
      >
        <table className="w-full text-sm">
          <thead className="bg-secondary text-secondary-foreground">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        "p-3 text-left font-medium whitespace-nowrap",
                        meta?.hideBelow && HIDE_BELOW[meta.hideBelow],
                        meta?.className,
                      )}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp className="size-3.5" aria-hidden />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="size-3.5" aria-hidden />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-50" aria-hidden />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
                {renderInline ? (
                  <th className="w-10 p-3">
                    <span className="sr-only">{t("details")}</span>
                  </th>
                ) : null}
              </tr>
            ))}
          </thead>
          <tbody>
            {status ? (
              <tr className="border-t border-border">
                <td colSpan={colSpan} className="p-6 text-center text-muted-foreground">
                  {status}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isOpen = expanded.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={cn(
                        "border-t border-border",
                        rowsAreClickable &&
                          "cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
                        isOpen && "bg-muted/30",
                      )}
                      {...rowHandlers(row.id, row.original)}
                    >
                      {row.getAllCells().map((cell) => {
                        const meta = cell.column.columnDef.meta;
                        return (
                          <td
                            key={cell.id}
                            className={cn(
                              "p-3 align-middle",
                              meta?.hideBelow && HIDE_BELOW[meta.hideBelow],
                              meta?.className,
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                      {renderInline ? (
                        <td className="p-3 text-muted-foreground">
                          <ChevronDown
                            className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                            aria-label={isOpen ? t("collapseRow") : t("expandRow")}
                          />
                        </td>
                      ) : null}
                    </tr>
                    {renderInline && isOpen ? (
                      <tr className="bg-muted/30">
                        <td colSpan={colSpan} className="px-3 pb-4">
                          {renderInline(row.original)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showPagination && paginationProps ? <Pagination {...paginationProps} /> : null}
    </div>
  );
}
