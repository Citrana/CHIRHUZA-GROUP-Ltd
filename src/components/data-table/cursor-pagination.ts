/**
 * Page-by-page navigation over a Convex cursor-paginated query. Convex
 * cursors only go forward, so we remember the cursor that opened each page
 * we've visited: `cursors[i]` starts page i, and the last one is the
 * current page. Going back pops; going forward pushes the page's
 * `continueCursor`. Any change of query args or page size starts over.
 */
export type CursorPaginationState = {
  /** Identifies the query args + page size this stack belongs to. */
  key: string;
  cursors: ReadonlyArray<string | null>;
};

export function initialCursorPagination(key: string): CursorPaginationState {
  return { key, cursors: [null] };
}

/** Starts over at page 1 when the args/page size (`key`) changed. */
export function syncCursorPagination(
  state: CursorPaginationState,
  key: string,
): CursorPaginationState {
  return state.key === key ? state : initialCursorPagination(key);
}

export function nextPage(
  state: CursorPaginationState,
  continueCursor: string,
): CursorPaginationState {
  return { ...state, cursors: [...state.cursors, continueCursor] };
}

export function previousPage(
  state: CursorPaginationState,
): CursorPaginationState {
  return state.cursors.length <= 1
    ? state
    : { ...state, cursors: state.cursors.slice(0, -1) };
}

export function currentCursor(state: CursorPaginationState): string | null {
  return state.cursors[state.cursors.length - 1];
}

/** 0-based index of the current page. */
export function pageIndex(state: CursorPaginationState): number {
  return state.cursors.length - 1;
}
