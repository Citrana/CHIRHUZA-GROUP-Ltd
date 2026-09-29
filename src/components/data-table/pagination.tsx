"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export const DEFAULT_PAGE_SIZES = [10, 25, 50] as const;

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
  isLoading?: boolean;
  className?: string;
};

/**
 * Prev / Next pagination with a rows-per-page picker. Works for both
 * client-side data (with a total) and Convex cursor pagination (without).
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
  isLoading = false,
  className,
}: PaginationProps) {
  const t = useTranslations("DataTable");
  const range =
    totalCount === undefined
      ? t("showing", { start: rangeStart, end: rangeEnd })
      : t("showingOf", { start: rangeStart, end: rangeEnd, total: totalCount });

  return (
    <nav
      aria-label={t("pagination")}
      className={cn(
        "flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-muted-foreground" aria-live="polite">
        {rangeEnd > 0 ? range : null}
      </p>
      <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 sm:size-9"
            onClick={onPrevious}
            disabled={!canPrevious || isLoading}
            aria-label={t("previous")}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-20 text-center tabular-nums">
            {t("page", { page })}
          </span>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 sm:size-9"
            onClick={onNext}
            disabled={!canNext || isLoading}
            aria-label={t("next")}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </nav>
  );
}
