"use client";

import { ArrowLeft, Compass, Home } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { Button, buttonVariants } from "@/components/ui/button";

/** The 404 page: any URL that matches nothing, or a record that doesn't exist. */
export function NotFoundScreen() {
  const t = useTranslations("NotFound");
  const tHeader = useTranslations("AppHeader");
  const router = useRouter();

  function goBack() {
    // Opened directly (no history in this tab): go home instead.
    if (window.history.length > 1) router.back();
    else router.push("/");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
      <title>{`${t("title")} · ${tHeader("brand")}`}</title>
      <p className="font-heading text-lg font-bold text-primary">{tHeader("brand")}</p>
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card p-6 text-center sm:p-8">
        <span className="flex size-12 items-center justify-center rounded-full bg-secondary">
          <Compass className="size-6 text-primary" aria-hidden />
        </span>
        <p className="font-heading text-6xl font-extrabold leading-none text-primary" aria-hidden>
          404
        </p>
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </div>
        <div className="mt-2 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Link href="/" className={buttonVariants({ size: "lg", className: "min-h-11" })}>
            <Home aria-hidden />
            {t("home")}
          </Link>
          <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={goBack}>
            <ArrowLeft aria-hidden />
            {t("back")}
          </Button>
        </div>
      </div>
    </main>
  );
}
