import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { SaleForm } from "@/components/sales/sale-form";

type Props = PageProps<"/[locale]/[service]/sales/new">;

/**
 * The phone sale form. `?date=YYYY-MM-DD&location=<id>` (from a missing
 * sales day on Analytics) pre-fills the day and the shop.
 */
export default async function NewSalePage({ params, searchParams }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  const { date, location } = await searchParams;
  return (
    <SaleForm
      service={service}
      initial={{
        day: typeof date === "string" ? date : undefined,
        locationId: typeof location === "string" ? location : undefined,
      }}
    />
  );
}
