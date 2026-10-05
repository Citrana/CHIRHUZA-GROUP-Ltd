"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { isPermissionKey } from "../../../convex/lib/permissions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ChangesTable } from "@/components/shared/changes-table";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";

type Snapshot = Record<string, unknown>;

function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Slide-in detail for one approval: what's being asked, the proposed
 * change as a before/after diff, the decision once made, and - only when
 * the server says this user can decide - Approve / Reject. The server
 * re-checks everything in approvals.decideApproval.
 */
export function ApprovalDrawer({
  approvalId,
  onClose,
}: {
  approvalId: Id<"approvals"> | null;
  onClose: () => void;
}) {
  const t = useTranslations("Approvals");
  const tPermissions = useTranslations("Permissions");
  const locale = useLocale();
  const approval = useQuery(
    api.approvals.get,
    approvalId ? { approvalId } : "skip",
  );
  const decide = useMutation(api.approvals.decideApproval);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState(false);
  const [shownId, setShownId] = useState(approvalId);

  // Reset the form when a different approval is opened.
  if (approvalId !== shownId) {
    setShownId(approvalId);
    setNote("");
    setError(false);
  }

  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  });

  async function handleDecision(decision: "approve" | "reject") {
    if (!approvalId) return;
    setSubmitting(decision);
    setError(false);
    try {
      await decide({ approvalId, decision, note: note.trim() || undefined });
      setNote("");
    } catch {
      setError(true);
    } finally {
      setSubmitting(null);
    }
  }

  const payload: unknown = approval?.payload;
  const before = isSnapshot(payload) && isSnapshot(payload.before) ? payload.before : undefined;
  const after = isSnapshot(payload) && isSnapshot(payload.after) ? payload.after : undefined;

  return (
    <Sheet open={approvalId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
      >
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>
            {approval ? t(`types.${approval.type}`) : t("title")}
          </SheetTitle>
        </SheetHeader>

        {approval === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">{t("loading")}</p>
        ) : approval === null ? (
          <p className="p-4 text-sm text-muted-foreground">{t("notFound")}</p>
        ) : (
          <div className="flex flex-col gap-5 p-4 text-sm">
            <ApprovalStatusBadge status={approval.status} className="self-start" />

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">{t("requestedBy")}</dt>
              <dd>{approval.requesterName ?? t("unknownUser")}</dd>
              <dt className="text-muted-foreground">{t("requestedAt")}</dt>
              <dd>{time.format(approval._creationTime)}</dd>
              <dt className="text-muted-foreground">{t("record")}</dt>
              <dd className="min-w-0">
                {approval.entityTable}{" "}
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {approval.entityId}
                </span>
              </dd>
              <dt className="text-muted-foreground">{t("requiredPermission")}</dt>
              <dd>
                {isPermissionKey(approval.requiredPermission)
                  ? tPermissions(approval.requiredPermission)
                  : approval.requiredPermission}
              </dd>
            </dl>

            <section className="flex flex-col gap-1.5">
              <h3 className="font-medium">{t("reason")}</h3>
              <p className="whitespace-pre-wrap text-muted-foreground">
                {approval.reason || t("noReason")}
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className="font-medium">{t("proposedChange")}</h3>
              {before || after ? (
                <ChangesTable before={before} after={after} />
              ) : (
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              )}
            </section>

            {approval.status !== "pending" ? (
              <section className="flex flex-col gap-1.5 rounded-md border border-border p-3">
                <h3 className="font-medium">{t("decision")}</h3>
                <p>
                  {t(approval.status === "approved" ? "approvedBy" : "rejectedBy", {
                    name: approval.deciderName ?? t("unknownUser"),
                  })}
                  {approval.decidedAt ? ` · ${time.format(approval.decidedAt)}` : null}
                </p>
                {approval.decisionNote ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {approval.decisionNote}
                  </p>
                ) : null}
              </section>
            ) : approval.canDecide ? (
              <section className="flex flex-col gap-3 rounded-md border border-border p-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="approval-note">{t("noteLabel")}</Label>
                  <textarea
                    id="approval-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t("notePlaceholder")}
                    rows={3}
                    maxLength={500}
                    className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
                  />
                </div>
                {error ? (
                  <p className="text-sm text-destructive">{t("decideError")}</p>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="h-11 flex-1 sm:h-9"
                    disabled={submitting !== null}
                    onClick={() => handleDecision("approve")}
                  >
                    <Check aria-hidden />
                    {submitting === "approve" ? t("deciding") : t("approve")}
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-11 flex-1 sm:h-9"
                    disabled={submitting !== null}
                    onClick={() => handleDecision("reject")}
                  >
                    <X aria-hidden />
                    {submitting === "reject" ? t("deciding") : t("reject")}
                  </Button>
                </div>
              </section>
            ) : (
              <p className="rounded-md bg-muted/50 p-3 text-muted-foreground">
                {t("waitingForDecision")}
              </p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
