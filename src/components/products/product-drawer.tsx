"use client";

import { useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, BadgeCheck, Pencil, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ProductFormDialog } from "@/components/products/product-form-dialog";
import { ProductStatusBadge } from "@/components/products/product-status-badge";

/**
 * Slide-in detail for one product, with the actions this user may take.
 * What's allowed comes from the server (`get`), which also re-checks every
 * action.
 */
export function ProductDrawer({
  service,
  productId,
  onClose,
}: {
  service: BusinessUnitKey;
  productId: Id<"products"> | null;
  onClose: () => void;
}) {
  const t = useTranslations("Products");
  const tCategories = useTranslations("ProductCategories");
  const tUnits = useTranslations("ProductUnits");
  const locale = useLocale();
  const product = useQuery(api.products.get, productId ? { productId } : "skip");
  const confirm = useMutation(api.products.confirm);
  const setArchived = useMutation(api.products.setArchived);
  const requestDeletion = useMutation(api.products.requestDeletion);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  });

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(false);
    try {
      await action();
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(event: FormEvent) {
    event.preventDefault();
    if (!productId) return;
    const ok = await run(() => requestDeletion({ productId, reason }));
    if (ok) {
      setDeleteOpen(false);
      setReason("");
    }
  }

  const empty = t("none");

  return (
    <>
      <Sheet open={productId !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent
          side="right"
          className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          <SheetHeader className="border-b border-border pr-12">
            <SheetTitle>{product?.name ?? t("title")}</SheetTitle>
          </SheetHeader>

          {product === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">{t("loading")}</p>
          ) : product === null ? (
            <p className="p-4 text-sm text-muted-foreground">{t("notFound")}</p>
          ) : (
            <div className="flex flex-col gap-5 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <ProductStatusBadge status={product.status} />
                <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
              </div>

              {product.pendingDeletionApprovalId ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive">
                  {t("deletionPendingNote")}{" "}
                  <Link href={`/${service}/approvals`} className="underline underline-offset-4">
                    {t("viewApprovals")}
                  </Link>
                </p>
              ) : null}

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">{t("categoryLabel")}</dt>
                <dd>{tCategories(product.category)}</dd>
                <dt className="text-muted-foreground">{t("unitLabel")}</dt>
                <dd>{tUnits(product.unit)}</dd>
                <dt className="text-muted-foreground">{t("lengthLabel")}</dt>
                <dd>
                  {product.lengthInches !== undefined
                    ? t("inches", { inches: product.lengthInches })
                    : empty}
                </dd>
                <dt className="text-muted-foreground">{t("colourLabel")}</dt>
                <dd>{product.colourName ?? empty}</dd>
                <dt className="text-muted-foreground">{t("brandLabel")}</dt>
                <dd>{product.brand ?? empty}</dd>
                <dt className="text-muted-foreground">{t("textureLabel")}</dt>
                <dd>{product.texture ?? empty}</dd>
                <dt className="text-muted-foreground">{t("createdBy")}</dt>
                <dd>
                  {product.createdByName ?? empty} · {time.format(product._creationTime)}
                </dd>
                {product.confirmedAt ? (
                  <>
                    <dt className="text-muted-foreground">{t("confirmedBy")}</dt>
                    <dd>
                      {product.confirmedByName ?? empty} · {time.format(product.confirmedAt)}
                    </dd>
                  </>
                ) : null}
              </dl>

              {product.status === "pending_confirmation" && !product.canConfirm ? (
                <p className="rounded-md bg-muted/50 p-3 text-muted-foreground">
                  {t("awaitingConfirmationNote")}
                </p>
              ) : null}

              {error ? <p className="text-destructive">{t("actionError")}</p> : null}

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {product.canConfirm ? (
                  <Button className="h-11 sm:h-9" disabled={busy} onClick={() => run(() => confirm({ productId: product._id }))}>
                    <BadgeCheck aria-hidden />
                    {t("confirm")}
                  </Button>
                ) : null}
                {product.canManage ? (
                  <>
                    <Button variant="outline" className="h-11 sm:h-9" disabled={busy} onClick={() => setEditOpen(true)}>
                      <Pencil aria-hidden />
                      {t("edit")}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-11 sm:h-9"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          setArchived({
                            productId: product._id,
                            archived: product.status !== "archived",
                          }),
                        )
                      }
                    >
                      {product.status === "archived" ? (
                        <>
                          <ArchiveRestore aria-hidden />
                          {t("restore")}
                        </>
                      ) : (
                        <>
                          <Archive aria-hidden />
                          {t("archive")}
                        </>
                      )}
                    </Button>
                    {!product.pendingDeletionApprovalId && !product.inUse ? (
                      <Button
                        variant="destructive"
                        className="h-11 sm:h-9"
                        disabled={busy}
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 aria-hidden />
                        {t("requestDeletion")}
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
              {product.canManage && product.inUse ? (
                <p className="text-xs text-muted-foreground">{t("inUseNote")}</p>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {product ? (
        <ProductFormDialog
          service={service}
          product={product}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      ) : null}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <form onSubmit={handleDelete}>
            <DialogHeader>
              <DialogTitle>{t("requestDeletionTitle")}</DialogTitle>
              <DialogDescription>{t("requestDeletionDescription")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2 py-4">
              <Label htmlFor="delete-reason">{t("reasonLabel")}</Label>
              <textarea
                id="delete-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={500}
                required
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
              />
              {error ? <p className="text-sm text-destructive">{t("actionError")}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
                {t("sendRequest")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
