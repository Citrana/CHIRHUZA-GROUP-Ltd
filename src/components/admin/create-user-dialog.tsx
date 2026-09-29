"use client";

import { useState, type FormEvent } from "react";
import { useAction, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { NativeSelect } from "@/components/ui/native-select";
import { useRoleText } from "@/components/admin/use-role-text";
import { LocationSelect } from "@/components/admin/location-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function CreateUserDialog() {
  const t = useTranslations("Admin.users");
  const roleText = useRoleText();
  const createUser = useAction(api.users.createUser);
  const roles = useQuery(api.rbac.listRoleOptions);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState<Id<"roles"> | "">("");
  const [locationId, setLocationId] = useState<Id<"locations"> | "">("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setEmail("");
    setRoleId("");
    setLocationId("");
    setError(null);
    setSubmitting(false);
    setGeneratedPassword(null);
    setCopied(false);
  }

  const locationRequired =
    roles?.find((r) => r._id === roleId)?.requiresLocation === true;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (roleId === "") return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await createUser({
        name,
        email,
        roleId,
        ...(locationId !== "" ? { locationId } : {}),
      });
      setGeneratedPassword(result.password);
    } catch {
      setError(t("createError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!generatedPassword) return;
    await navigator.clipboard.writeText(generatedPassword);
    setCopied(true);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogTrigger
        render={<Button>{t("createUser")}</Button>}
      />
      <DialogContent>
        {generatedPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("passwordDialogTitle")}</DialogTitle>
              <DialogDescription>
                {t("passwordDialogWarning")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">
                {generatedPassword}
              </code>
              <Button type="button" variant="outline" onClick={handleCopy}>
                {copied ? t("copiedLabel") : t("copyButton")}
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                {t("closeButton")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{t("createUser")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <RequiredFieldsHint />
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-user-name" required>{t("nameLabel")}</Label>
                <Input
                  id="new-user-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-user-email" required>{t("emailLabel")}</Label>
                <Input
                  id="new-user-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-user-role" required>{t("roleLabel")}</Label>
                <NativeSelect
                  id="new-user-role"
                  value={roleId}
                  onChange={(event) =>
                    setRoleId(event.target.value as Id<"roles">)
                  }
                  required
                >
                  <option value="" disabled>
                    {t("selectRole")}
                  </option>
                  {roles?.map((role) => (
                    <option key={role._id} value={role._id}>
                      {roleText(role).name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-user-location" required={locationRequired}>{t("locationLabel")}</Label>
                <LocationSelect
                  id="new-user-location"
                  value={locationId}
                  onValueChange={setLocationId}
                  emptyLabel={
                    locationRequired ? t("selectLocation") : t("noLocation")
                  }
                  required={locationRequired}
                />
                {locationRequired ? (
                  <p className="text-xs text-muted-foreground">
                    {t("locationRequiredHint")}
                  </p>
                ) : null}
              </div>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={submitting}>
                {submitting ? t("creating") : t("createButton")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
