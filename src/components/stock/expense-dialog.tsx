"use client";

import { useState, type FormEvent } from "react";
import { Paperclip } from "lucide-react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { EXPENSE_CATEGORIES, MAX_RECEIPT_BYTES } from "../../../convex/lib/stockBatches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Category = (typeof EXPENSE_CATEGORIES)[number];

/**
 * Add (no `expense`) or edit a batch expense, with an optional receipt
 * photo/PDF. Expenses are kept aside: they never change product costs.
 */
export function ExpenseDialog({
  batchId,
  expense,
  open,
  onOpenChange,
}: {
  batchId: Id<"stockBatches">;
  expense?: Doc<"stockBatchExpenses">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("StockBatches");
  const addExpense = useMutation(api.stockBatches.addExpense);
  const updateExpense = useMutation(api.stockBatches.updateExpense);
  const uploadUrl = useMutation(api.stockBatches.generateReceiptUploadUrl);

  const [category, setCategory] = useState<Category | "">("");
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [keepReceipt, setKeepReceipt] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const openKey = open ? (expense?._id ?? "new") : null;
  if (openKey !== loadedFor) {
    setLoadedFor(openKey);
    if (openKey) {
      setCategory(expense?.category ?? "");
      setAmount(expense?.amount ?? null);
      setNote(expense?.note ?? "");
      setFile(null);
      setKeepReceipt(true);
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!category || amount === null) {
      setError(t("expenseMissing"));
      return;
    }
    if (file && (file.size > MAX_RECEIPT_BYTES || !(file.type.startsWith("image/") || file.type === "application/pdf"))) {
      setError(t("receiptInvalid"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let receiptFileId: Id<"_storage"> | undefined =
        keepReceipt ? expense?.receiptFileId : undefined;
      if (file) {
        const url = await uploadUrl({ batchId });
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!response.ok) throw new Error("Upload failed");
        receiptFileId = ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      const fields = {
        category,
        amount,
        ...(note.trim() ? { note } : {}),
        ...(receiptFileId ? { receiptFileId } : {}),
      };
      if (expense) {
        await updateExpense({ expenseId: expense._id, ...fields });
      } else {
        await addExpense({ batchId, ...fields });
      }
      onOpenChange(false);
    } catch {
      setError(t("saveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{expense ? t("editExpense") : t("addExpense")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <RequiredFieldsHint />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="expense-category" required>
                  {t("categoryLabel")}
                </Label>
                <NativeSelect
                  id="expense-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as Category)}
                  required
                >
                  <option value="" disabled>
                    {t("selectCategory")}
                  </option>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`categories.${c}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="expense-amount" required>
                  {t("amountLabel")}
                </Label>
                <MoneyInput id="expense-amount" currency="USD" valueMinor={amount} onCommit={setAmount} required />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="expense-note">{t("noteLabel")}</Label>
              <Input id="expense-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="expense-receipt">{t("receiptLabel")}</Label>
              {expense?.receiptFileId && keepReceipt && !file ? (
                <div className="flex items-center gap-2 text-sm">
                  <Paperclip className="size-4" aria-hidden />
                  {t("receiptAttached")}
                  <Button type="button" variant="ghost" size="sm" onClick={() => setKeepReceipt(false)}>
                    {t("removeReceipt")}
                  </Button>
                </div>
              ) : null}
              <Input
                id="expense-receipt"
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">{t("receiptHint")}</p>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
