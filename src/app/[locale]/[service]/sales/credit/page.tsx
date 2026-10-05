import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { CreditPanel } from "@/components/sales/credit-panel";

type Props = PageProps<"/[locale]/[service]/sales/credit">;

/** Customers who owe money, and their balances. */
export default async function CreditPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <CreditPanel service={service} />;
}
