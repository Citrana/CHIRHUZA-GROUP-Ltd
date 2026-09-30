import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { WithdrawalsPanel } from "@/components/withdrawals/withdrawals-panel";

type Props = PageProps<"/[locale]/[service]/withdrawals">;

/** Overrides the `[module]` placeholder: cash withdrawals, kept apart from business figures. */
export default async function WithdrawalsPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <WithdrawalsPanel service={service} />;
}
