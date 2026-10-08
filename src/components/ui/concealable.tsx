"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A figure hidden behind an animated blur until revealed (privacy on
 * shared screens). Starts hidden on every visit; `reveal` also shows it
 * (e.g. tapping the blurred figure). The blur is instant with reduced
 * motion, and a hidden figure can't be selected.
 */
export function useConcealed(enabled = true) {
  const [shown, setShown] = useState(false);
  const hidden = enabled && !shown;
  return {
    shown,
    hidden,
    toggle: () => setShown((v) => !v),
    reveal: () => setShown(true),
    blurClass: enabled
      ? cn(
          "transition-[filter,opacity] duration-300 ease-out motion-reduce:transition-none",
          hidden ? "pointer-events-none select-none opacity-60 blur-[10px]" : "opacity-100 blur-0",
        )
      : undefined,
  };
}

/** The eye that shows / hides a concealed figure (44px tap target). */
export function ConcealToggle({
  shown,
  onToggle,
  labels,
  className,
}: {
  shown: boolean;
  onToggle: () => void;
  labels: { show: string; hide: string };
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      aria-label={shown ? labels.hide : labels.show}
      className={cn(
        "-my-3 inline-flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-current",
        className,
      )}
    >
      {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
    </button>
  );
}
