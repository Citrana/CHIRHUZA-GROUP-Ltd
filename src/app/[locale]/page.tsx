import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { ServicePicker } from "@/components/shell/service-picker";

type Props = PageProps<"/[locale]">;

/** First screen after login (AuthGate sends signed-in users to "/"). */
export default async function Home({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return <ServicePicker />;
}
