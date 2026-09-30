import { notFound } from "next/navigation";
import { isBusinessUnitKey } from "../../../../../convex/lib/businessUnits";
import { PayrollPanel } from "@/components/payroll/payroll-panel";

type Props = PageProps<"/[locale]/[service]/payroll">;

/** Overrides the `[module]` placeholder: payroll entries and their approval. */
export default async function PayrollPage({ params }: Props) {
  const { service } = await params;
  if (!isBusinessUnitKey(service)) {
    notFound();
  }
  return <PayrollPanel service={service} />;
}
