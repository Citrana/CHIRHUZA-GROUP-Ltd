import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConvexStatus } from "@/components/convex-status";
import { LocaleSwitcher } from "@/components/locale-switcher";

type Props = PageProps<"/[locale]">;

export default async function Home({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const t = await getTranslations("Home");
  const convexConfigured = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-8 p-8">
      <div className="absolute right-6 top-6">
        <LocaleSwitcher />
      </div>

      <div className="text-center">
        <h1 className="font-heading text-3xl font-bold tracking-tight text-primary">
          {t("companyName")}
        </h1>
        <p className="mt-2 text-muted-foreground">{t("tagline")}</p>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("statusTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {convexConfigured ? (
            <ConvexStatus />
          ) : (
            <Badge variant="secondary">{t("statusNotConfigured")}</Badge>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
