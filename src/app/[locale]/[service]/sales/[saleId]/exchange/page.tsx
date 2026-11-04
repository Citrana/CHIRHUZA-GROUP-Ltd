import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../../convex/lib/businessUnits";
import { ExchangeForm } from "@/components/sales/exchange-form";

type Props = PageProps<"/[locale]/[service]/sales/[saleId]/exchange">;

/** Exchange products of a sale: brought back, taken instead, the difference. */
export default async function SaleExchangePage({ params }: Props) {
  const { service, saleId } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <ExchangeForm service={service} saleId={saleId} />;
}
