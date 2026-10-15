"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { formatMoney } from "../../../convex/lib/money";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { ClientDialog } from "@/components/fleet/client-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCan } from "@/lib/use-can";

type ClientRow = FunctionReturnType<typeof api.clients.list>[number];

/** Saved clients (companies and people) and what each owes; add / edit for transport.contracts.manage. */
export function ClientsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Clients");
  const locale = useLocale();
  const canView = useCan("transport.view");
  const canManage = useCan("transport.contracts.manage");
  const clients = useQuery(api.clients.list, canView ? { businessUnitKey: service } : "skip");
  const [editing, setEditing] = useState<ClientRow | "new" | null>(null);

  if (canView === undefined) return null;
  if (!canView) return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;

  const money = (cents: number) => formatMoney(cents, "USD", locale);
  const kindBadge = (c: ClientRow) => <Badge variant="outline">{t(`kinds.${c.kind}`)}</Badge>;
  const owes = (c: ClientRow) =>
    c.balance > 0 ? <span className="text-destructive">{money(c.balance)}</span> : <span className="text-muted-foreground">—</span>;
  const editButton = (c: ClientRow) =>
    canManage ? (
      <Button variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={t("edit", { name: c.name })} onClick={() => setEditing(c)}>
        <Pencil aria-hidden />
      </Button>
    ) : null;

  const columns: DataTableColumn<ClientRow>[] = [
    {
      id: "name",
      header: t("nameHeader"),
      accessorFn: (c) => [c.name, c.contactName, c.email].filter(Boolean).join(" "),
      cell: ({ row }) => (
        <span className="flex items-center gap-2 font-medium">
          {row.original.name}
          {kindBadge(row.original)}
        </span>
      ),
    },
    { id: "contact", header: t("contactLabel"), cell: ({ row }) => row.original.contactName ?? "—", meta: { hideBelow: "lg" } },
    { id: "phone", header: t("phoneLabel"), accessorFn: (c) => c.phone ?? "", cell: ({ row }) => row.original.phone ?? "—", meta: { hideBelow: "md" } },
    { id: "email", header: t("emailLabel"), cell: ({ row }) => row.original.email ?? "—", meta: { hideBelow: "lg" } },
    { id: "owes", header: t("owesHeader"), cell: ({ row }) => owes(row.original), meta: { className: "whitespace-nowrap tabular-nums" } },
    { id: "actions", header: "", cell: ({ row }) => editButton(row.original), meta: { className: "w-12 text-right" } },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canManage ? (
          <Button size="lg" className="min-h-11" onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            {t("add")}
          </Button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={clients}
        getRowId={(c) => c._id}
        emptyMessage={t("empty")}
        search={{ placeholder: t("searchPlaceholder") }}
        renderCard={(c) => (
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-2 font-medium">
                {c.name}
                {kindBadge(c)}
              </span>
              <span className="text-xs text-muted-foreground">{[c.contactName, c.phone, c.email].filter(Boolean).join(" · ") || "—"}</span>
              {c.balance > 0 ? <span className="text-sm">{t("owes", { amount: money(c.balance) })}</span> : null}
            </div>
            {editButton(c)}
          </div>
        )}
      />
      {editing !== null ? (
        <ClientDialog
          key={editing === "new" ? "new" : editing._id}
          service={service}
          client={editing === "new" ? null : editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </div>
  );
}
