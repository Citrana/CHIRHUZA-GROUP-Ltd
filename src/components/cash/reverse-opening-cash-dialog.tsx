"use client";

import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";

/**
 * Reverse an opening cash record (the only way to undo one): takes its full
 * amount back out of cash on hand, with a required reason. Above the
 * threshold it waits in Approvals.
 */
export function ReverseOpeningCashDialog({
  target,
  onClose,
}: {
  target: { id: Id<"openingCash">; label: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations("Cash");
  const reverse = useMutation(api.cash.reverseOpeningCash);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function close() {
    setReason("");
    setError(null);
    onClose();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    if (!reason.trim()) {
      setError(t("missingFields"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await reverse({ openingCashId: target.id, reason });
      close();
    } catch (e) {
      const data = e instanceof ConvexError ? e.data : null;
      setError(typeof data === "string" ? data : t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("reverseTitle")}</DialogTitle>
            <DialogDescription>{t("reverseHint", { record: target?.label ?? "" })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="flex flex-col gap-2">
              <Label htmlFor="opening-cash-reverse-reason" required>
                {t("reasonLabel")}
              </Label>
              <textarea
                id="opening-cash-reverse-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("reasonPlaceholder")}
                rows={3}
                maxLength={300}
                required
                className={TEXTAREA_CLASS}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" onClick={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="destructive" className="min-h-11" disabled={submitting}>
              {submitting ? t("saving") : t("reverse")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
