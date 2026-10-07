import {
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";

/** Per-column options understood by DataTable (`columnDef.meta`). */
export type DataTableColumnMeta = {
  /** Hide this column on screens narrower than the breakpoint. */
  hideBelow?: "sm" | "md" | "lg";
  /** Extra classes for this column's cells (header and body). */
  className?: string;
  /** Right-align the column (numbers): header label and cells line up on the right. */
  align?: "right";
};

/**
 * The TanStack Table (v9) features every DataTable registers: search
 * (global filtering), sorting and client-side pagination. Features must be
 * registered explicitly in v9 - an API is missing if its feature isn't here.
 */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
  },
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableFeatures = typeof dataTableFeatures;

/** Column definition type for DataTable columns. */
export type DataTableColumn<TData extends RowData> = ColumnDef<
  DataTableFeatures,
  TData
>;
