"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { CLIENT_KINDS, type ClientKind } from "../../../convex/lib/transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";

export type SavedClient = { _id: Id<"clients">; name: string };

/**
 * Add a client (a company or a person), or edit one (`client` given). Only
 * the name is required. Adding a name that already exists hands back that
 * client instead (`onSaved`), so the contract form picks them. Mounted with
 * a `key` per client.
 */
export function ClientDialog({
  service,
  client,
  initialName = "",
  open,
  onOpenChange,
  onSaved,
}: {
  service: BusinessUnitKey;
  client: Doc<"clients"> | null;
  initialName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (client: SavedClient) => void;
}) {
  const t = useTranslations("Clients");
  const create = useMutation(api.clients.create);
  const update = useMutation(api.clients.update);
  const [kind, setKind] = useState<ClientKind>(client?.kind ?? "company");
  const [name, setName] = useState(client?.name ?? initialName);
  const [contactName, setContactName] = useState(client?.contactName ?? "");
  const [phone, setPhone] = useState(client?.phone ?? "");
  const [email, setEmail] = useState(client?.email ?? "");
  const [address, setAddress] = useState(client?.address ?? "");
  const [note, setNote] = useState(client?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    const optional = { contactName, phone, email, address, note };
    const fields = {
      kind,
      name,
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value.trim())),
    };
    const cleanName = name.trim().replace(/\s+/g, " ");
    try {
      if (client) {
        await update({ clientId: client._id, ...fields });
        onSaved?.({ _id: client._id, name: cleanName });
      } else {
        const id = await create({ businessUnitKey: service, ...fields });
        onSaved?.({ _id: id, name: cleanName });
      }
      onOpenChange(false);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; message?: string; clientId?: Id<"clients"> } | string) : null;
      if (!client && typeof data === "object" && data?.code === "DUPLICATE_CLIENT" && data.clientId && onSaved) {
        // Already a client: pick them.
        onSaved({ _id: data.clientId, name: cleanName });
        onOpenChange(false);
      } else {
        setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("saveError"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, props: React.ComponentProps<"input"> = {}) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => set(e.target.value)} className="h-11" {...props} />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{client ? t("editTitle", { name: client.name }) : t("newTitle")}</DialogTitle>
            <DialogDescription>{t("hint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_1fr]">
              <div className="flex flex-col gap-2">
                <Label htmlFor="client-kind" required>
                  {t("kindLabel")}
                </Label>
                <NativeSelect id="client-kind" value={kind} onChange={(e) => setKind(e.target.value as ClientKind)} className="h-11 w-full">
                  {CLIENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`kinds.${k}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="client-name" required>
                  {kind === "company" ? t("companyNameLabel") : t("personNameLabel")}
                </Label>
                <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className="h-11" />
              </div>
            </div>
            {kind === "company" ? field("client-contact", t("contactLabel"), contactName, setContactName, { maxLength: 100 }) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field("client-phone", t("phoneLabel"), phone, setPhone, { type: "tel", inputMode: "tel", maxLength: 30 })}
              {field("client-email", t("emailLabel"), email, setEmail, { type: "email", inputMode: "email", maxLength: 120 })}
            </div>
            {field("client-address", t("addressLabel"), address, setAddress, { maxLength: 200 })}
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-note">{t("noteLabel")}</Label>
              <textarea id="client-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={TEXTAREA_CLASS} />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="h-11 sm:h-9">
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
