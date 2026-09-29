"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { PaginatedQueryItem } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_STATUSES,
  type ProductCategory,
  type ProductStatus,
} from "../../../convex/lib/products";
import { DataTable } from "@/components/data-table/data-table";
import type { DataTableColumn } from "@/components/data-table/features";
import { useCursorPaginatedQuery } from "@/components/data-table/use-cursor-paginated-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ProductDrawer } from "@/components/products/product-drawer";
import { ProductFormDialog } from "@/components/products/product-form-dialog";
import { ProductStatusBadge } from "@/components/products/product-status-badge";
import { useCan } from "@/lib/use-can";

type ProductRow = PaginatedQueryItem<typeof api.products.list>;

/** The service's product catalogue: search, filters, create, and details. */
export function ProductsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Products");
  const tCategories = useTranslations("ProductCategories");
  const canView = useCan("products.view");
  const canManage = useCan("products.manage");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ProductCategory | "">("");
  const [status, setStatus] = useState<ProductStatus | "">("");
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<Id<"products"> | null>(null);

  const { results, pagination } = useCursorPaginatedQuery(
    api.products.list,
    canView
      ? {
          businessUnitKey: service,
          ...(search.trim() ? { search } : {}),
          ...(category ? { category } : {}),
          ...(status ? { status } : {}),
        }
      : "skip"
  );

  if (canView === undefined) return null;
  if (!canView) {
    return <p className="text-sm text-muted-foreground">{t("accessDenied")}</p>;
  }

  const details = (p: ProductRow) =>
    [
      p.lengthInches !== undefined ? t("inches", { inches: p.lengthInches }) : null,
      p.colourName,
    ]
      .filter(Boolean)
      .join(" · ");

  const statusCell = (p: ProductRow) => (
    <div className="flex flex-wrap gap-1">
      <ProductStatusBadge status={p.status} />
      {p.pendingDeletion ? (
        <Badge variant="destructive">{t("deletionPending")}</Badge>
      ) : null}
    </div>
  );

  const columns: DataTableColumn<ProductRow>[] = [
    {
      id: "name",
      header: t("nameHeader"),
      cell: ({ row }) => (
        <div className="min-w-40">
          <p className="font-medium">{row.original.name}</p>
          {row.original.brand ? (
            <p className="text-xs text-muted-foreground">{row.original.brand}</p>
          ) : null}
        </div>
      ),
    },
    {
      id: "sku",
      header: t("skuHeader"),
      cell: ({ row }) => row.original.sku,
      meta: { hideBelow: "sm", className: "whitespace-nowrap font-mono text-xs" },
    },
    {
      id: "category",
      header: t("categoryHeader"),
      cell: ({ row }) => tCategories(row.original.category),
      meta: { className: "whitespace-nowrap" },
    },
    {
      id: "details",
      header: t("detailsHeader"),
      cell: ({ row }) => details(row.original) || t("none"),
      meta: { hideBelow: "lg", className: "whitespace-nowrap text-muted-foreground" },
    },
    {
      id: "status",
      header: t("statusHeader"),
      cell: ({ row }) => statusCell(row.original),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canManage ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden />
            {t("create")}
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={results}
        getRowId={(p) => p._id}
        emptyMessage={t("empty")}
        search={{ placeholder: t("searchPlaceholder"), value: search, onChange: setSearch }}
        pagination={{ mode: "server", ...pagination }}
        onRowClick={(p) => setOpenId(p._id)}
        toolbar={
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <NativeSelect
              aria-label={t("categoryHeader")}
              className="h-10 sm:h-8 sm:w-44"
              value={category}
              onChange={(e) => setCategory(e.target.value as ProductCategory | "")}
            >
              <option value="">{t("allCategories")}</option>
              {PRODUCT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {tCategories(c)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t("statusHeader")}
              className="h-10 sm:h-8 sm:w-48"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProductStatus | "")}
            >
              <option value="">{t("allStatuses")}</option>
              {PRODUCT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`statuses.${s}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        }
        renderCard={(p) => (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{p.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{p.sku}</p>
              </div>
              {statusCell(p)}
            </div>
            <p className="text-sm text-muted-foreground">
              {[tCategories(p.category), details(p), p.brand].filter(Boolean).join(" · ")}
            </p>
          </div>
        )}
      />

      <ProductFormDialog service={service} open={createOpen} onOpenChange={setCreateOpen} />
      <ProductDrawer service={service} productId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
