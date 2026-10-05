import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { SaleForm } from "@/components/sales/sale-form";

type Props = PageProps<"/[locale]/[service]/sales/new">;

/** The phone sale form. */
export default async function NewSalePage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <SaleForm service={service} />;
}
