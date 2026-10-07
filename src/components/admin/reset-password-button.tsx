"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { ConvexError } from "convex/values";
import { useAction } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Super Admin resets a user who forgot their password: after a
 * confirmation, a new password is shown once (to share in person or by
 * phone). The user is signed out everywhere and must choose their own
 * password at the next sign-in.
 */
export function ResetPasswordButton({ user }: { user: Doc<"users"> }) {
  const t = useTranslations("Admin.users");
  const resetPassword = useAction(api.users.resetPassword);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setPassword(null);
    setCopied(false);
    setError(null);
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await resetPassword({ userId: user._id });
      setPassword(result.password);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { message?: string } | string) : null;
      setError(typeof data === "object" && data?.message ? data.message : typeof data === "string" ? data : t("resetError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!password) return;
    await navigator.clipboard.writeText(password);
    setCopied(true);
  }

  return (
    <>
      <Button variant="outline" size="sm" className="min-h-10" onClick={() => setOpen(true)}>
        <KeyRound aria-hidden />
        {t("resetPassword")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent>
          {password ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("resetDoneTitle", { name: user.name })}</DialogTitle>
                <DialogDescription>{t("resetDoneWarning", { name: user.name })}</DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm break-all">
                  {password}
                </code>
                <Button type="button" variant="outline" className="min-h-11" onClick={copy}>
                  {copied ? t("copiedLabel") : t("copyButton")}
                </Button>
              </div>
              <DialogFooter>
                <Button type="button" className="min-h-11" onClick={close}>
                  {t("closeButton")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t("resetConfirmTitle", { name: user.name })}</DialogTitle>
                <DialogDescription>{t("resetConfirmText")}</DialogDescription>
              </DialogHeader>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" className="min-h-11" onClick={close}>
                  {t("cancel")}
                </Button>
                <Button type="button" className="min-h-11" disabled={submitting} onClick={confirm}>
                  {submitting ? t("resetting") : t("resetConfirm")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
