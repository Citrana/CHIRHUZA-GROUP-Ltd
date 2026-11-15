import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../../convex/lib/businessUnits";
import { SalesCheckPanel } from "@/components/sales/sales-check-panel";

type Props = PageProps<"/[locale]/[service]/sales/check">;

/** Check sales: find the day a list of products was sold. */
export default async function SalesCheckPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <SalesCheckPanel service={service} />;
}
