"use client";

import { useState } from "react";
import { Building2, UserPlus, UserRound } from "lucide-react";
import { useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { ClientDialog, type SavedClient } from "@/components/fleet/client-dialog";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";

/**
 * A contract's client: search saved clients (name, contact, phone, email)
 * and pick one, or add a new one - a name that already exists picks that
 * client instead of creating a duplicate.
 */
export function ClientPicker({
  service,
  value,
  onChange,
  invalid,
}: {
  service: BusinessUnitKey;
  value: SavedClient | null;
  onChange: (client: SavedClient | null) => void;
  invalid?: boolean;
}) {
  const t = useTranslations("Clients");
  const locale = useLocale();
  const canAdd = useCan("transport.contracts.manage");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const results = useQuery(api.clients.search, value || !query.trim() ? "skip" : { businessUnitKey: service, query });
  const money = (cents: number) => formatMoney(cents, "USD", locale);

  if (value) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3">
        <span className="font-medium">{value.name}</span>
        <Button type="button" variant="ghost" className="min-h-10" onClick={() => onChange(null)}>
          {t("change")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <DataTableSearch
        value={query}
        onChange={setQuery}
        placeholder={t("searchPlaceholder")}
        className={invalid ? "rounded-md ring-2 ring-destructive/40 sm:max-w-none" : "sm:max-w-none"}
      />
      {query.trim() ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {results === undefined ? null : results.length === 0 ? (
            <li className="p-3 text-sm text-muted-foreground">{t("noMatch")}</li>
          ) : (
            results.map((c) => {
              const Icon = c.kind === "company" ? Building2 : UserRound;
              return (
                <li key={c._id}>
                  <button
                    type="button"
                    onClick={() => onChange({ _id: c._id, name: c.name })}
                    className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={t(`kinds.${c.kind}`)} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.name}</span>
                        {c.contactName || c.phone ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {[c.contactName, c.phone].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {c.balance > 0 ? <span className="shrink-0 text-xs text-muted-foreground">{t("owes", { amount: money(c.balance) })}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
      {canAdd ? (
        <Button type="button" variant="outline" className="min-h-11 self-start" onClick={() => setAdding(true)}>
          <UserPlus aria-hidden />
          {t("add")}
        </Button>
      ) : null}
      {adding ? (
        <ClientDialog
          service={service}
          client={null}
          initialName={query}
          open
          onOpenChange={setAdding}
          onSaved={(client) => {
            onChange(client);
            setQuery("");
          }}
        />
      ) : null}
    </div>
  );
}
