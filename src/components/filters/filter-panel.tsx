"use client";

import { useState, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMediaQuery } from "@/lib/use-media-query";

/** An active filter, shown as a removable chip; `clear` returns the filters without it. */
export type FilterChip<V> = { id: string; label: string; clear: (value: V) => V };

type FilterPanelProps<V> = {
  /** The applied filters. */
  value: V;
  onApply: (value: V) => void;
  /** The filters with nothing chosen (Clear). */
  emptyValue: V;
  /** The chips for the applied filters; their count shows on the button. */
  chips: (value: V) => FilterChip<V>[];
  /** The fields, editing a draft that only applies on Apply. */
  children: (draft: V, setDraft: (next: V) => void) => ReactNode;
};

/**
 * A "Filters" button that opens every filter of a list - a bottom sheet on
 * phones, a drop-down from `sm` up - with Clear / Apply, and the applied
 * filters as removable chips beside it. Closing without Apply changes
 * nothing. Usage: src/components/data-table/README.md ("Filters").
 */
export function FilterPanel<V>({ value, onApply, emptyValue, chips, children }: FilterPanelProps<V>) {
  const t = useTranslations("Filters");
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const active = chips(value);

  const onOpenChange = (next: boolean) => {
    if (next) setDraft(value);
    setOpen(next);
  };
  const apply = () => {
    onApply(draft);
    setOpen(false);
  };

  const trigger = (
    <Button variant="outline" className="h-11 sm:h-8">
      <SlidersHorizontal aria-hidden />
      {t("button")}
      {active.length > 0 ? <Badge className="tabular-nums">{active.length}</Badge> : null}
    </Button>
  );
  const fields = <div className="flex flex-col gap-4">{children(draft, setDraft)}</div>;
  const actions = (
    <div className="flex gap-2">
      <Button variant="outline" className="h-11 flex-1 sm:h-8" onClick={() => setDraft(emptyValue)}>
        {t("clear")}
      </Button>
      <Button className="h-11 flex-1 sm:h-8" onClick={apply}>
        {t("apply")}
      </Button>
    </div>
  );

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      {isDesktop ? (
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger render={trigger} />
          <PopoverContent align="start" className="w-[22rem] gap-4 p-4">
            <PopoverTitle>{t("title")}</PopoverTitle>
            {fields}
            {actions}
          </PopoverContent>
        </Popover>
      ) : (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetTrigger render={trigger} />
          <SheetContent side="bottom" className="max-h-[90dvh]">
            <SheetHeader>
              <SheetTitle>{t("title")}</SheetTitle>
            </SheetHeader>
            <div className="overflow-y-auto px-4">{fields}</div>
            <SheetFooter>{actions}</SheetFooter>
          </SheetContent>
        </Sheet>
      )}
      {active.map((chip) => (
        <Button
          key={chip.id}
          variant="secondary"
          size="sm"
          className="h-11 rounded-full pr-2 sm:h-7"
          aria-label={t("removeFilter", { name: chip.label })}
          onClick={() => onApply(chip.clear(value))}
        >
          {chip.label}
          <X aria-hidden />
        </Button>
      ))}
      {active.length > 0 ? (
        <Button variant="ghost" size="sm" className="h-11 sm:h-7" onClick={() => onApply(emptyValue)}>
          {t("clear")}
        </Button>
      ) : null}
    </div>
  );
}
