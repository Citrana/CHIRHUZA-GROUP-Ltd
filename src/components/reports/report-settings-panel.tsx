"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLocale, useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { MINUTE_STEP, REPORT_SECTIONS, type ReportFrequency, type ReportSection } from "../../../convex/lib/reports";
import { BUSINESS_TIME_ZONE } from "../../../convex/lib/time";
import { Link } from "@/i18n/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { useCan } from "@/lib/use-can";

type Settings = FunctionReturnType<typeof api.reports.getSettings>;
type Draft = Pick<Settings, "enabled" | "frequency" | "dayOfWeek" | "dayOfMonth" | "time" | "sections" | "recipientIds">;

/** Every quarter hour of the day: "00:00" ... "23:45". */
const TIMES = Array.from({ length: (24 * 60) / MINUTE_STEP }, (_, i) => {
  const minutes = i * MINUTE_STEP;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const FREQUENCIES: ReportFrequency[] = ["daily", "weekly", "monthly"];
const CHECKBOX = "size-5 shrink-0 accent-primary";
const ROW = "flex min-h-11 items-center gap-3 text-sm";

/** The caller's own scheduled report for this service: when, what, to whom, how. */
export function ReportSettingsPanel({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Reports");
  const canSettings = useCan("reports.settings");
  const canCash = useCan("cash.view");
  const settings = useQuery(api.reports.getSettings, canSettings ? { businessUnitKey: service } : "skip");
  const people = useQuery(api.reports.recipientOptions, canSettings ? {} : "skip");

  if (canSettings === undefined) return null;
  if (!canSettings) return <p className="text-sm text-muted-foreground">{t("settings.accessDenied")}</p>;
  if (!settings) return null;
  return <SettingsForm service={service} settings={settings} people={people ?? []} canCash={canCash === true} />;
}

function SettingsForm({
  service,
  settings,
  people,
  canCash,
}: {
  service: BusinessUnitKey;
  settings: Settings;
  people: Array<{ _id: Id<"users">; name: string }>;
  canCash: boolean;
}) {
  const t = useTranslations("Reports");
  const locale = useLocale();
  const save = useMutation(api.reports.saveSettings);
  const [draft, setDraft] = useState<Draft>(() => {
    const { enabled, frequency, dayOfWeek, dayOfMonth, time, sections, recipientIds } = settings;
    return { enabled, frequency, dayOfWeek, dayOfMonth, time, sections, recipientIds };
  });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const back = (
    <Link href={`/${service}/reports`} className={buttonVariants({ variant: "ghost", className: "min-h-11 self-start" })}>
      <ArrowLeft aria-hidden />
      {t("back")}
    </Link>
  );

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setStatus("idle");
  };
  const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const sections = REPORT_SECTIONS.filter((s) => s !== "cash" || canCash);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("saving");
    try {
      await save({ businessUnitKey: service, ...draft, channels: ["in_app"] });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {back}
      <div>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("settings.subtitle")}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5 rounded-lg border border-border p-4">
        <RequiredFieldsHint />
        <label className={`${ROW} font-medium`}>
          <input type="checkbox" className={CHECKBOX} checked={draft.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          {t("settings.enabled")}
        </label>
        <p className="-mt-3 text-sm text-muted-foreground">
          {settings.nextRunAt !== null && settings.enabled ? t("settings.next", { date: when.format(settings.nextRunAt) }) : t("settings.off")}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="report-frequency" required>
              {t("settings.frequency")}
            </Label>
            <NativeSelect id="report-frequency" value={draft.frequency} onChange={(e) => update({ frequency: e.target.value as ReportFrequency })} required>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`settings.frequencies.${f}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          {draft.frequency === "weekly" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="report-day" required>
                {t("settings.day")}
              </Label>
              <NativeSelect id="report-day" value={draft.dayOfWeek} onChange={(e) => update({ dayOfWeek: Number(e.target.value) })} required>
                {WEEKDAYS.map((d) => (
                  <option key={d} value={d}>
                    {t(`weekdays.${d}` as Parameters<typeof t>[0])}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {draft.frequency === "monthly" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="report-day-of-month" required>
                {t("settings.dayOfMonth")}
              </Label>
              <NativeSelect id="report-day-of-month" value={draft.dayOfMonth} onChange={(e) => update({ dayOfMonth: Number(e.target.value) })} required>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="report-time" required>
              {t("settings.time")}
            </Label>
            <NativeSelect id="report-time" value={draft.time} onChange={(e) => update({ time: e.target.value })} required>
              {TIMES.map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div className="-mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          <p>{t("settings.timeHint")}</p>
          <p>{t(`settings.covers.${draft.frequency}`)}</p>
          <p>{t("settings.compareNote")}</p>
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">
            {t("settings.sectionsLabel")} <span className="text-destructive">*</span>
          </legend>
          {sections.map((s) => (
            <label key={s} className={ROW}>
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={draft.sections.includes(s)}
                onChange={() => update({ sections: toggle<ReportSection>(draft.sections, s) })}
              />
              {t(`sections.${s}`)}
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">
            {t("settings.recipientsLabel")} <span className="text-destructive">*</span>
          </legend>
          {people.map((p) => (
            <label key={p._id} className={ROW}>
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={draft.recipientIds.includes(p._id)}
                onChange={() => update({ recipientIds: toggle<Id<"users">>(draft.recipientIds, p._id) })}
              />
              {p.name}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">{t("settings.recipientsHint")}</p>
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t("settings.channelLabel")}</legend>
          <label className={ROW}>
            <input type="checkbox" className={CHECKBOX} checked disabled />
            {t("settings.channels.in_app")}
          </label>
          <label className={`${ROW} text-muted-foreground`}>
            <input type="checkbox" className={CHECKBOX} checked={false} disabled />
            {t("settings.channels.email")} ({t("settings.comingSoon")})
          </label>
        </fieldset>

        {status === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {t("settings.saveError")}
          </p>
        ) : null}
        {status === "saved" ? (
          <p className="text-sm text-primary" role="status">
            {t("settings.saved")}
          </p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          className="min-h-11 self-start"
          disabled={status === "saving" || draft.sections.length === 0 || draft.recipientIds.length === 0}
        >
          {status === "saving" ? t("settings.saving") : t("settings.save")}
        </Button>
      </form>
    </div>
  );
}
