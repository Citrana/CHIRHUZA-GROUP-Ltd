import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import {
  BUSINESS_UNIT_KEYS,
  isBusinessUnitKey,
} from "../../../../convex/lib/businessUnits";
import { ServiceShell } from "@/components/shell/service-shell";

export function generateStaticParams() {
  return BUSINESS_UNIT_KEYS.map((service) => ({ service }));
}

type Props = LayoutProps<"/[locale]/[service]">;

/** The selected service lives in the URL: /[locale]/[service]/... */
export default async function ServiceLayout({ children, params }: Props) {
  const { locale, service } = await params;
  if (!hasLocale(routing.locales, locale) || !isBusinessUnitKey(service)) {
    notFound();
  }
  setRequestLocale(locale);

  return <ServiceShell service={service}>{children}</ServiceShell>;
}
