import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { CashPanel } from "@/components/cash/cash-panel";

type Props = PageProps<"/[locale]/[service]/cash">;

/** Overrides the `[module]` placeholder: cash on hand and opening cash (owner only). */
export default async function CashPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <CashPanel service={service} />;
}
