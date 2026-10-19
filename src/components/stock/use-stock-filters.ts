"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";
import { parseStockFilters, stockFiltersQuery, type StockFilters } from "@/lib/stock-movement";

/**
 * The Stock overview's view and report filters, kept in the URL query so a
 * view can be shared and Back undoes a filter. `replace` (e.g. typing in
 * search) changes the URL without adding a history entry.
 */
export function useStockFilters() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const filters = useMemo(() => parseStockFilters(new URLSearchParams(params.toString())), [params]);
  const setFilters = useCallback(
    (patch: Partial<StockFilters>, { replace = false }: { replace?: boolean } = {}) => {
      const query = stockFiltersQuery({ ...filters, ...patch });
      const href = query ? `${pathname}?${query}` : pathname;
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [filters, pathname, router],
  );
  return [filters, setFilters] as const;
}

export type SetStockFilters = ReturnType<typeof useStockFilters>[1];
