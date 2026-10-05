import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../../convex/lib/businessUnits";
import { CustomerCredit } from "@/components/sales/customer-credit";

type Props = PageProps<"/[locale]/[service]/sales/credit/[customerId]">;

/** One customer's credit: sales, payments, record a payment. */
export default async function CustomerCreditPage({ params }: Props) {
  const { service, customerId } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <CustomerCredit service={service} customerId={customerId} />;
}
