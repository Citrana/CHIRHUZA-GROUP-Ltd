"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Search box that reports its value after the user pauses typing. */
export function DataTableSearch({
  value,
  onChange,
  placeholder,
  delayMs = 200,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  delayMs?: number;
  className?: string;
}) {
  const t = useTranslations("DataTable");
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);

  // Follow outside changes (e.g. "clear filters") without an effect.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft, value, onChange, delayMs]);

  return (
    <div className={cn("relative w-full sm:max-w-xs", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder ?? t("search")}
        aria-label={placeholder ?? t("search")}
        className="h-10 pl-8 sm:h-8"
      />
    </div>
  );
}
