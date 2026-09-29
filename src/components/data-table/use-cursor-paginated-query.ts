"use client";

import { useState } from "react";
import {
  useQuery,
  type OptionalRestArgsOrSkip,
  type PaginatedQueryArgs,
  type PaginatedQueryItem,
  type PaginatedQueryReference,
} from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { PaginationProps } from "@/components/data-table/pagination";
import {
  currentCursor,
  initialCursorPagination,
  nextPage,
  pageIndex,
  previousPage,
  syncCursorPagination,
} from "@/components/data-table/cursor-pagination";

/**
 * Page-by-page (Prev / Next) view of a Convex query that takes
 * `paginationOpts` - the same queries `usePaginatedQuery` works with, but
 * showing one page at a time instead of a growing list. Changing `args` or
 * the page size goes back to page 1. The previous page stays on screen
 * while the next one loads.
 */
export function useCursorPaginatedQuery<Query extends PaginatedQueryReference>(
  query: Query,
  args: PaginatedQueryArgs<Query> | "skip",
  { initialPageSize = 25 }: { initialPageSize?: number } = {},
): {
  results: PaginatedQueryItem<Query>[] | undefined;
  isLoading: boolean;
  pagination: PaginationProps;
} {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const key = `${pageSize}:${args === "skip" ? "skip" : JSON.stringify(args)}`;
  const [storedState, setState] = useState(() => initialCursorPagination(key));
  const state = syncCursorPagination(storedState, key);
  if (state !== storedState) {
    setState(state);
  }

  const queryArgs = (
    args === "skip"
      ? ["skip"]
      : [
          {
            ...args,
            paginationOpts: { numItems: pageSize, cursor: currentCursor(state) },
          },
        ]
  ) as OptionalRestArgsOrSkip<Query>;
  const result: FunctionReturnType<Query> | undefined = useQuery(
    query,
    ...queryArgs,
  );

  // Keep showing the last page for these same args while the next loads.
  const [shown, setShown] = useState<{
    key: string;
    result: FunctionReturnType<Query>;
  } | null>(null);
  if (result !== undefined && shown?.result !== result) {
    setShown({ key, result });
  }
  const visible = result ?? (shown?.key === key ? shown.result : undefined);
  const isLoading = result === undefined;

  const index = pageIndex(state);
  const page: PaginatedQueryItem<Query>[] | undefined = visible?.page;
  const count = page?.length ?? 0;
  const rangeStart = count > 0 ? index * pageSize + 1 : 0;

  return {
    results: page,
    isLoading,
    pagination: {
      page: index + 1,
      canPrevious: index > 0,
      canNext: result !== undefined && !result.isDone,
      onPrevious: () => setState(previousPage(state)),
      onNext: () => {
        if (result && !result.isDone) {
          setState(nextPage(state, result.continueCursor));
        }
      },
      pageSize,
      onPageSizeChange: setPageSize,
      rangeStart,
      rangeEnd: count > 0 ? rangeStart + count - 1 : 0,
      isLoading,
    },
  };
}
