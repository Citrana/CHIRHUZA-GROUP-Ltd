export type PageItem = number | "ellipsis-start" | "ellipsis-end";

/**
 * Which page buttons to show for `current` (1-based) of `total` pages,
 * always 7 slots at most: first and last page, the current page with a
 * neighbour on each side, and ellipses for the gaps. For example
 * `pageWindow(6, 12)` → `[1, "ellipsis-start", 5, 6, 7, "ellipsis-end", 12]`.
 */
export function pageWindow(current: number, total: number): PageItem[] {
  if (total <= 0) return [];
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const page = Math.min(Math.max(current, 1), total);

  let left = page - 1;
  let right = page + 1;
  if (page <= 4) {
    left = 2;
    right = 5;
  } else if (page >= total - 3) {
    left = total - 4;
    right = total - 1;
  }

  const items: PageItem[] = [1];
  if (left > 2) items.push("ellipsis-start");
  for (let n = left; n <= right; n++) items.push(n);
  if (right < total - 1) items.push("ellipsis-end");
  items.push(total);
  return items;
}
