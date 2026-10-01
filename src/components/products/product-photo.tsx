"use client";

import { Shirt } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-10",
  md: "size-14",
  lg: "aspect-square w-full max-w-64",
} as const;

/**
 * A product's photo as a square thumbnail (Mode products have one), or a
 * placeholder when it has none. Decorative next to the product's name, so
 * the image itself has an empty alt.
 */
export function ProductPhoto({
  url,
  size = "sm",
  className,
}: {
  url: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted",
        SIZES[size],
        className,
      )}
    >
      {url ? (
        // Convex storage URLs are dynamic; a plain <img> keeps it simple.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <Shirt className={size === "lg" ? "size-10" : "size-4"} aria-hidden style={{ color: "var(--muted-foreground)" }} />
      )}
    </span>
  );
}
