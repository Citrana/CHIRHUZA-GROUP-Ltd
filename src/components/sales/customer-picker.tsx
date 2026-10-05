"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { DataTableSearch } from "@/components/data-table/data-table-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PickedCustomer = { _id: Id<"customers">; name: string };

/**
 * The credit sale's customer: search the customer list by name or phone,
 * or add a new customer inline. A name that already exists picks that
 * customer instead of creating a duplicate.
 */
export function CustomerPicker({
  service,
  value,
  onChange,
  invalid,
}: {
  service: BusinessUnitKey;
  value: PickedCustomer | null;
  onChange: (customer: PickedCustomer | null) => void;
  invalid?: boolean;
}) {
  const t = useTranslations("Sales");
  const tCredit = useTranslations("Credit");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const results = useQuery(api.customers.search, value || !query.trim() ? "skip" : { businessUnitKey: service, query });
  const create = useMutation(api.customers.create);
  const money = (cents: number) => formatMoney(cents, "USD", locale);

  if (value) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3">
        <span className="font-medium">{value.name}</span>
        <Button type="button" variant="ghost" className="min-h-10" onClick={() => onChange(null)}>
          {t("changeCustomer")}
        </Button>
      </div>
    );
  }

  async function add() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const id = await create({ businessUnitKey: service, name, ...(phone.trim() ? { phone } : {}) });
      onChange({ _id: id, name: name.trim().replace(/\s+/g, " ") });
      setAdding(false);
      setName("");
      setPhone("");
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; message?: string; customerId?: Id<"customers"> } | string) : null;
      if (typeof data === "object" && data?.code === "DUPLICATE_CUSTOMER" && data.customerId) {
        // Already a customer: pick them.
        onChange({ _id: data.customerId, name: name.trim().replace(/\s+/g, " ") });
        setAdding(false);
      } else {
        setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("customerAddError"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {!adding ? (
        <>
          <DataTableSearch
            value={query}
            onChange={setQuery}
            placeholder={t("customerSearchPlaceholder")}
            className={invalid ? "sm:max-w-none rounded-md ring-2 ring-destructive/40" : "sm:max-w-none"}
          />
          {query.trim() ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {results === undefined ? null : results.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">{t("noCustomerMatch")}</li>
              ) : (
                results.map((c) => (
                  <li key={c._id}>
                    <button
                      type="button"
                      onClick={() => onChange({ _id: c._id, name: c.name })}
                      className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.name}</span>
                        {c.phone ? <span className="block text-xs text-muted-foreground">{c.phone}</span> : null}
                      </span>
                      {c.balance > 0 ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{t("customerOwes", { amount: money(c.balance) })}</span>
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            onClick={() => {
              setAdding(true);
              setName(query);
            }}
          >
            <UserPlus aria-hidden />
            {t("newCustomer")}
          </Button>
        </>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-customer-name" required>
              {t("newCustomerName")}
            </Label>
            <Input id="new-customer-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="h-11" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-customer-phone">{t("newCustomerPhone")}</Label>
            <Input
              id="new-customer-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={30}
              className="h-11"
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-11" disabled={saving || !name.trim()} onClick={add}>
              {saving ? t("adding") : t("addCustomer")}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setAdding(false)}>
              {tCredit("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
