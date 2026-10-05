"use client";

import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { PRODUCT_PROFILES, normalizeColourName } from "../../../convex/lib/products";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/lib/use-can";

/**
 * The service's product settings, shown inside the service shell
 * (/[service]/settings): lengths (inches) for hair, sizes for fashion (per
 * PRODUCT_PROFILES), and colours. Values in use are deactivated, never
 * deleted, so products using them keep them.
 */
export function ProductSettingsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("ProductSettings");
  const canManage = useCan("products.settings");
  const profile = PRODUCT_PROFILES[service];

  if (canManage === undefined) return null;
  if (!canManage) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {profile.attributes.size ? t("subtitleSizes") : t("subtitle")}
        </p>
      </div>
      {profile.attributes.length ? <LengthsSection service={service} /> : null}
      {profile.attributes.size ? <SizesSection service={service} /> : null}
      <ColoursSection service={service} />
    </div>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  const t = useTranslations("ProductSettings");
  return (
    <Badge variant={active ? "secondary" : "outline"}>
      {active ? t("active") : t("inactive")}
    </Badge>
  );
}

type LengthRow = Doc<"productLengths"> & { productCount: number };

/** The server refused because the value already exists (unique per service). */
function isDuplicateError(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    (error.data as { code?: string } | undefined)?.code === "DUPLICATE"
  );
}
type ColourRow = Doc<"productColours"> & { productCount: number };
type SizeRow = Doc<"productSizes"> & { productCount: number };

/**
 * Delete for a setting value. Only possible when no product uses it (the
 * server re-checks and answers IN_USE with the count); otherwise it's
 * disabled and explains why - deactivate instead.
 */
function DeleteSettingButton({
  label,
  productCount,
  onDelete,
}: {
  label: string;
  productCount: number;
  onDelete: () => Promise<unknown>;
}) {
  const t = useTranslations("ProductSettings");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = productCount > 0;
  const inUseMessage = t("inUse", { count: productCount });

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setOpen(false);
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; count?: number }) : null;
      setError(
        data?.code === "IN_USE"
          ? t("inUse", { count: data.count ?? 1 })
          : t("deleteError"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={inUse}
        title={inUse ? inUseMessage : undefined}
        aria-label={inUse ? `${t("delete")} — ${inUseMessage}` : undefined}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 aria-hidden />
        {t("delete")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { value: label })}</DialogTitle>
            <DialogDescription>{t("deleteConfirm")}</DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="destructive" disabled={busy} onClick={handleDelete}>
              <Trash2 aria-hidden />
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProductCount({ count }: { count: number }) {
  const t = useTranslations("ProductSettings");
  return (
    <span className={count > 0 ? "" : "text-muted-foreground"}>
      {t("productCount", { count })}
    </span>
  );
}

function LengthsSection({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("ProductSettings");
  const tProducts = useTranslations("Products");
  const lengths = useQuery(api.productOptions.listLengths, {
    businessUnitKey: service,
    includeInactive: true,
  });
  const addLength = useMutation(api.productOptions.addLength);
  const setActive = useMutation(api.productOptions.setLengthActive);
  const deleteLength = useMutation(api.productOptions.deleteLength);
  const [inches, setInches] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live uniqueness check (the server enforces it too), incl. deactivated.
  const lengthTaken =
    inches !== "" && (lengths ?? []).some((l) => l.inches === Number(inches));
  const takenMessage = t("lengthExists", {
    value: tProducts("inches", { inches: Number(inches) || 0 }),
  });

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (lengthTaken) return;
    setError(null);
    try {
      await addLength({ businessUnitKey: service, inches: Number(inches) });
      setInches("");
    } catch (e) {
      setError(isDuplicateError(e) ? takenMessage : t("lengthError"));
    }
  }

  const columns: DataTableColumn<LengthRow>[] = [
    {
      id: "inches",
      header: t("lengthHeader"),
      cell: ({ row }) => tProducts("inches", { inches: row.original.inches }),
      meta: { className: "font-medium" },
    },
    {
      id: "status",
      header: t("statusHeader"),
      cell: ({ row }) => <ActiveBadge active={row.original.active} />,
    },
    {
      id: "products",
      header: t("productsHeader"),
      cell: ({ row }) => <ProductCount count={row.original.productCount} />,
      meta: { hideBelow: "sm", className: "whitespace-nowrap" },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("actionsHeader")}</span>,
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActive({ lengthId: row.original._id, active: !row.original.active })}
          >
            {row.original.active ? t("deactivate") : t("reactivate")}
          </Button>
          <DeleteSettingButton
            label={tProducts("inches", { inches: row.original.inches })}
            productCount={row.original.productCount}
            onDelete={() => deleteLength({ lengthId: row.original._id })}
          />
        </div>
      ),
      meta: { className: "text-right" },
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-semibold">{t("lengthsTitle")}</h2>
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-length" required>{t("inchesLabel")}</Label>
          <Input
            id="new-length"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            step={1}
            value={inches}
            onChange={(e) => {
              setInches(e.target.value);
              setError(null);
            }}
            className="h-10 w-28 sm:h-8"
            aria-invalid={lengthTaken || undefined}
            aria-describedby={lengthTaken || error ? "new-length-error" : undefined}
            required
          />
        </div>
        <Button type="submit" className="h-10 sm:h-8" disabled={lengthTaken}>
          <Plus aria-hidden />
          {t("addLength")}
        </Button>
      </form>
      {lengthTaken || error ? (
        <p id="new-length-error" className="text-sm text-destructive" role="alert">
          {lengthTaken ? takenMessage : error}
        </p>
      ) : null}
      <DataTable
        columns={columns}
        data={lengths}
        getRowId={(l) => l._id}
        emptyMessage={t("noLengths")}
      />
    </section>
  );
}

function ColoursSection({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("ProductSettings");
  const colours = useQuery(api.productOptions.listColours, {
    businessUnitKey: service,
    includeInactive: true,
  });
  const addColour = useMutation(api.productOptions.addColour);
  const renameColour = useMutation(api.productOptions.renameColour);
  const setActive = useMutation(api.productOptions.setColourActive);
  const deleteColour = useMutation(api.productOptions.deleteColour);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Doc<"productColours"> | null>(null);
  const [newName, setNewName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  // Live uniqueness check (case/space-insensitive, incl. deactivated), the
  // same rule the server enforces. `exceptId` skips the colour being renamed.
  const colourTaken = (value: string, exceptId?: Doc<"productColours">["_id"]) =>
    value.trim() !== "" &&
    (colours ?? []).some(
      (c) =>
        c._id !== exceptId &&
        normalizeColourName(c.name) === normalizeColourName(value),
    );
  const takenMessage = (value: string) =>
    t("colourExists", { value: value.trim().replace(/\s+/g, " ") });
  const addTaken = colourTaken(name);
  const renameTaken = renaming !== null && colourTaken(newName, renaming._id);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (addTaken) return;
    setError(null);
    try {
      await addColour({ businessUnitKey: service, name });
      setName("");
    } catch (e) {
      setError(isDuplicateError(e) ? takenMessage(name) : t("colourError"));
    }
  }

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || renameTaken) return;
    setRenameError(null);
    try {
      await renameColour({ colourId: renaming._id, name: newName });
      setRenaming(null);
    } catch (e) {
      setRenameError(isDuplicateError(e) ? takenMessage(newName) : t("colourError"));
    }
  }

  const columns: DataTableColumn<ColourRow>[] = [
    {
      accessorKey: "name",
      header: t("colourHeader"),
      meta: { className: "font-medium" },
    },
    {
      id: "status",
      header: t("statusHeader"),
      cell: ({ row }) => <ActiveBadge active={row.original.active} />,
    },
    {
      id: "products",
      header: t("productsHeader"),
      cell: ({ row }) => <ProductCount count={row.original.productCount} />,
      meta: { hideBelow: "sm", className: "whitespace-nowrap" },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("actionsHeader")}</span>,
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRenaming(row.original);
              setNewName(row.original.name);
              setRenameError(null);
            }}
          >
            <Pencil aria-hidden />
            {t("rename")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActive({ colourId: row.original._id, active: !row.original.active })}
          >
            {row.original.active ? t("deactivate") : t("reactivate")}
          </Button>
          <DeleteSettingButton
            label={row.original.name}
            productCount={row.original.productCount}
            onDelete={() => deleteColour({ colourId: row.original._id })}
          />
        </div>
      ),
      meta: { className: "text-right" },
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-semibold">{t("coloursTitle")}</h2>
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-colour" required>{t("colourNameLabel")}</Label>
          <Input
            id="new-colour"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder={t("colourPlaceholder")}
            maxLength={50}
            className="h-10 w-56 sm:h-8"
            aria-invalid={addTaken || undefined}
            aria-describedby={addTaken || error ? "new-colour-error" : undefined}
            required
          />
        </div>
        <Button type="submit" className="h-10 sm:h-8" disabled={addTaken}>
          <Plus aria-hidden />
          {t("addColour")}
        </Button>
      </form>
      {addTaken || error ? (
        <p id="new-colour-error" className="text-sm text-destructive" role="alert">
          {addTaken ? takenMessage(name) : error}
        </p>
      ) : null}
      <DataTable
        columns={columns}
        data={colours}
        getRowId={(c) => c._id}
        emptyMessage={t("noColours")}
        search={{ placeholder: t("searchColours") }}
      />

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <form onSubmit={handleRename}>
            <DialogHeader>
              <DialogTitle>{t("renameTitle")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2 py-4">
              <Label htmlFor="rename-colour" required>{t("colourNameLabel")}</Label>
              <Input
                id="rename-colour"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setRenameError(null);
                }}
                maxLength={50}
                aria-invalid={renameTaken || undefined}
                required
              />
              {renameTaken || renameError ? (
                <p className="text-sm text-destructive" role="alert">
                  {renameTaken ? takenMessage(newName) : renameError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={renameTaken}>{t("save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Fashion sizes: add, rename, reorder (the order pickers show), deactivate, delete when unused. */
function SizesSection({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("ProductSettings");
  const sizes = useQuery(api.productOptions.listSizes, { businessUnitKey: service, includeInactive: true });
  const addSize = useMutation(api.productOptions.addSize);
  const renameSize = useMutation(api.productOptions.renameSize);
  const moveSize = useMutation(api.productOptions.moveSize);
  const setActive = useMutation(api.productOptions.setSizeActive);
  const deleteSize = useMutation(api.productOptions.deleteSize);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Doc<"productSizes"> | null>(null);
  const [newName, setNewName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  // Same uniqueness rule as the server (case/space-insensitive, incl. inactive).
  const sizeTaken = (value: string, exceptId?: Doc<"productSizes">["_id"]) =>
    value.trim() !== "" &&
    (sizes ?? []).some((z) => z._id !== exceptId && normalizeColourName(z.name) === normalizeColourName(value));
  const takenMessage = (value: string) => t("sizeExists", { value: value.trim().replace(/\s+/g, " ") });
  const addTaken = sizeTaken(name);
  const renameTaken = renaming !== null && sizeTaken(newName, renaming._id);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (addTaken) return;
    setError(null);
    try {
      await addSize({ businessUnitKey: service, name });
      setName("");
    } catch (e) {
      setError(isDuplicateError(e) ? takenMessage(name) : t("sizeError"));
    }
  }

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || renameTaken) return;
    setRenameError(null);
    try {
      await renameSize({ sizeId: renaming._id, name: newName });
      setRenaming(null);
    } catch (e) {
      setRenameError(isDuplicateError(e) ? takenMessage(newName) : t("sizeError"));
    }
  }

  const count = sizes?.length ?? 0;
  const columns: DataTableColumn<SizeRow>[] = [
    { accessorKey: "name", header: t("sizeHeader"), meta: { className: "font-medium" } },
    { id: "status", header: t("statusHeader"), cell: ({ row }) => <ActiveBadge active={row.original.active} /> },
    {
      id: "products",
      header: t("productsHeader"),
      cell: ({ row }) => <ProductCount count={row.original.productCount} />,
      meta: { hideBelow: "sm", className: "whitespace-nowrap" },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("actionsHeader")}</span>,
      cell: ({ row }) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("moveUp")}
            disabled={row.index === 0}
            onClick={() => moveSize({ sizeId: row.original._id, direction: "up" })}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("moveDown")}
            disabled={row.index === count - 1}
            onClick={() => moveSize({ sizeId: row.original._id, direction: "down" })}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRenaming(row.original);
              setNewName(row.original.name);
              setRenameError(null);
            }}
          >
            <Pencil aria-hidden />
            {t("rename")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setActive({ sizeId: row.original._id, active: !row.original.active })}>
            {row.original.active ? t("deactivate") : t("reactivate")}
          </Button>
          <DeleteSettingButton
            label={row.original.name}
            productCount={row.original.productCount}
            onDelete={() => deleteSize({ sizeId: row.original._id })}
          />
        </div>
      ),
      meta: { className: "text-right" },
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-semibold">{t("sizesTitle")}</h2>
      <p className="-mt-2 text-xs text-muted-foreground">{t("sizesHint")}</p>
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-size" required>
            {t("sizeNameLabel")}
          </Label>
          <Input
            id="new-size"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder={t("sizePlaceholder")}
            maxLength={20}
            className="h-10 w-40 sm:h-8"
            aria-invalid={addTaken || undefined}
            aria-describedby={addTaken || error ? "new-size-error" : undefined}
            required
          />
        </div>
        <Button type="submit" className="h-10 sm:h-8" disabled={addTaken}>
          <Plus aria-hidden />
          {t("addSize")}
        </Button>
      </form>
      {addTaken || error ? (
        <p id="new-size-error" className="text-sm text-destructive" role="alert">
          {addTaken ? takenMessage(name) : error}
        </p>
      ) : null}
      <DataTable columns={columns} data={sizes} getRowId={(z) => z._id} emptyMessage={t("noSizes")} pagination={false} />

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <form onSubmit={handleRename}>
            <DialogHeader>
              <DialogTitle>{t("renameSizeTitle")}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2 py-4">
              <Label htmlFor="rename-size" required>
                {t("sizeNameLabel")}
              </Label>
              <Input
                id="rename-size"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setRenameError(null);
                }}
                maxLength={20}
                aria-invalid={renameTaken || undefined}
                required
              />
              {renameTaken || renameError ? (
                <p className="text-sm text-destructive" role="alert">
                  {renameTaken ? takenMessage(newName) : renameError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={renameTaken}>
                {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
