import { notFound } from "next/navigation";
import { SHELL_MODULES, findShellModule } from "@/lib/shell-modules";
import { ModulePlaceholder } from "@/components/shell/module-placeholder";

export function generateStaticParams() {
  return SHELL_MODULES.map((m) => ({ module: m.key }));
}

type Props = PageProps<"/[locale]/[service]/[module]">;

/**
 * Placeholder for every module until it's built. A real module gets its own
 * static folder (e.g. [service]/sales/page.tsx), which takes precedence.
 */
export default async function ModulePage({ params }: Props) {
  const { module } = await params;
  const shellModule = findShellModule(module);
  if (!shellModule) {
    notFound();
  }
  return <ModulePlaceholder moduleKey={shellModule.key} />;
}
