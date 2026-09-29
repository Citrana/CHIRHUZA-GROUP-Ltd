import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { AuditLogPanel } from "@/components/admin/audit-log-panel";

type Props = PageProps<"/[locale]/admin/audit">;

export default async function AdminAuditPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 p-4 md:p-8">
      <AuditLogPanel />
    </main>
  );
}
