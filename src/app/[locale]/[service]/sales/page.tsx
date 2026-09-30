import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { SalesPanel } from "@/components/sales/sales-panel";

type Props = PageProps<"/[locale]/[service]/sales">;

/** Overrides the `[module]` placeholder: the sales list. */
export default async function SalesPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <SalesPanel service={service} />;
}
