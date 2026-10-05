"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { pageWindow } from "@/components/data-table/page-window";
import { cn } from "@/lib/utils";

export const DEFAULT_PAGE_SIZES = [10, 20, 50] as const;
export const DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZES[0];

export type PaginationProps = {
  /** 1-based. */
  page: number;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  onPageSizeChange: (pageSize: number) => void;
  /** 1-based, inclusive; 0/0 when the page is empty. */
  rangeStart: number;
  rangeEnd: number;
  /** Known only for client-side data; cursor-paginated data has no total. */
  totalCount?: number;
  /**
   * Number of pages, known only when the total is (client-side data). With
   * `onPageChange` it enables numbered page buttons and first/last jumps.
   */
  pageCount?: number;
  /** Jump to a 1-based page. */
  onPageChange?: (page: number) => void;
  isLoading?: boolean;
  className?: string;
};

const NAV_BUTTON = "size-11 sm:size-9";

/**
 * Pager with a rows-per-page picker. With a known page count (client data)
 * it shows numbered pages plus first/last; for Convex cursor pagination
 * (no total) it shows previous / "Page N" / next. On phones the numbers
 * collapse to "5 / 12".
 */
export function Pagination({
  page,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  onPageSizeChange,
  rangeStart,
  rangeEnd,
  totalCount,
  pageCount,
  onPageChange,
  isLoading = false,
  className,
}: PaginationProps) {
  const t = useTranslations("DataTable");
  const range =
    totalCount === undefined
      ? t("showing", { start: rangeStart, end: rangeEnd })
      : t("showingOf", { start: rangeStart, end: rangeEnd, total: totalCount });
  const numbered = pageCount !== undefined && pageCount > 0 && onPageChange !== undefined;

  return (
    <nav
      aria-label={t("pagination")}
      className={cn(
        "flex flex-col gap-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-start">
        <p className="text-muted-foreground" aria-live="polite">
          {rangeEnd > 0 ? range : null}
        </p>
        <label className="flex items-center gap-2 text-muted-foreground">
          <span>{t("rowsPerPage")}</span>
          <NativeSelect
            className="h-9 w-20"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>

      <div className="flex items-center justify-center gap-1 sm:justify-end">
        {numbered ? (
          <Button
            variant="outline"
            size="icon-lg"
            className={NAV_BUTTON}
            onClick={() => onPageChange(1)}
            disabled={!canPrevious || isLoading}
            aria-label={t("firstPage")}
          >
            <ChevronsLeft />
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="icon-lg"
          className={NAV_BUTTON}
          onClick={onPrevious}
          disabled={!canPrevious || isLoading}
          aria-label={t("previous")}
        >
          <ChevronLeft />
        </Button>

        {numbered ? (
          <>
            {/* Phones: compact "5 / 12". */}
            <span className="min-w-16 text-center tabular-nums sm:hidden">
              {t("pageOf", { page, total: pageCount })}
            </span>
            {/* sm and up: numbered pages. */}
            <ul className="hidden items-center gap-1 sm:flex">
              {pageWindow(page, pageCount).map((item) =>
                typeof item === "number" ? (
                  <li key={item}>
                    <Button
                      variant={item === page ? "default" : "ghost"}
                      size="icon-lg"
                      className="min-w-9 px-2 tabular-nums"
                      aria-current={item === page ? "page" : undefined}
                      aria-label={t("goToPage", { page: item })}
                      disabled={isLoading}
                      onClick={() => onPageChange(item)}
                    >
                      {item}
                    </Button>
                  </li>
                ) : (
                  <li key={item} className="px-1 text-muted-foreground" aria-hidden>
                    …
                  </li>
                ),
              )}
            </ul>
          </>
        ) : (
          <span className="min-w-20 text-center tabular-nums">
            {t("page", { page })}
          </span>
        )}

        <Button
          variant="outline"
          size="icon-lg"
          className={NAV_BUTTON}
          onClick={onNext}
          disabled={!canNext || isLoading}
          aria-label={t("next")}
        >
          <ChevronRight />
        </Button>
        {numbered ? (
          <Button
            variant="outline"
            size="icon-lg"
            className={NAV_BUTTON}
            onClick={() => onPageChange(pageCount)}
            disabled={!canNext || isLoading}
            aria-label={t("lastPage")}
          >
            <ChevronsRight />
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
