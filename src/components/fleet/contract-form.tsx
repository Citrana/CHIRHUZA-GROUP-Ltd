"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BusinessUnitKey } from "../../../convex/lib/businessUnits";
import { TRANSPORT_PAYMENT_METHODS, type TransportPaymentMethod } from "../../../convex/lib/transport";
import { businessDayOf } from "../../../convex/lib/time";
import { Link, useRouter } from "@/i18n/navigation";
import { ClientPicker } from "@/components/fleet/client-picker";
import type { SavedClient } from "@/components/fleet/client-dialog";
import { useDayFormat } from "@/components/fleet/contract-bits";
import { ContractTermsFields, termsArgs, termsProblem, type ContractTerms } from "@/components/fleet/contract-terms-fields";
import { TEXTAREA_CLASS } from "@/components/requisitions/new-requisition-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/ui/money-input";
import { NativeSelect } from "@/components/ui/native-select";
import { RequiredFieldsHint } from "@/components/ui/required-fields-hint";
import { useCan } from "@/lib/use-can";

/**
 * A new contract, on one phone-friendly page: the car (its driver comes
 * along), the client (pick a saved one or add one), the dates and prices,
 * the driver's pay per day, and what the client paid at signing.
 */
export function ContractForm({ service }: { service: BusinessUnitKey }) {
  const t = useTranslations("Contracts");
  const router = useRouter();
  const canManage = useCan("transport.contracts.manage");
  const [today] = useState(() => businessDayOf(Date.now()));
  const cars = useQuery(api.cars.list, canManage ? { businessUnitKey: service, today } : "skip");
  const create = useMutation(api.contracts.create);
  const day = useDayFormat();
  const [carId, setCarId] = useState("");
  const [client, setClient] = useState<SavedClient | null>(null);
  const [terms, setTerms] = useState<ContractTerms>({
    startDay: today,
    days: "",
    dayRate: null,
    agreedTotal: null,
    priceChangeReason: "",
    driverDayRate: null,
  });
  const [paidNow, setPaidNow] = useState<number | null>(null);
  const [method, setMethod] = useState<TransportPaymentMethod>("cash");
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (canManage === undefined) return null;
  if (!canManage) return <p className="text-sm text-muted-foreground">{t("cannotCreate")}</p>;

  const activeCars = (cars ?? []).filter((c) => c.status === "active");
  const car = activeCars.find((c) => c._id === carId);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = !carId || !client ? "missingFields" : termsProblem(terms);
    if (problem) {
      setError(t(problem));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { contractId } = await create({
        businessUnitKey: service,
        carId: carId as Id<"cars">,
        clientId: client!._id,
        ...termsArgs(terms),
        ...(note.trim() ? { note } : {}),
        ...(paidNow ? { firstPayment: { amount: paidNow, method, ...(paidOn !== today ? { paidOn } : {}) } } : {}),
      });
      router.push(`/${service}/contracts/${contractId}`);
    } catch (e) {
      const data = e instanceof ConvexError ? e.data : null;
      setError(typeof data === "string" ? data : t("saveError"));
      setSubmitting(false);
    }
  }

  const section = "flex flex-col gap-4 rounded-xl border border-border bg-card p-4";
  return (
    <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href={`/${service}/contracts`} className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Link>
        <h1 className="font-heading text-2xl font-bold text-primary">{t("newTitle")}</h1>
        <RequiredFieldsHint />
      </div>

      <section className={section}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-car" required>
            {t("carLabel")}
          </Label>
          <NativeSelect id="contract-car" value={carId} onChange={(e) => setCarId(e.target.value)} required className="h-11 w-full">
            <option value="">{t("chooseCar")}</option>
            {activeCars.map((c) => (
              <option key={c._id} value={c._id}>
                {[c.plateNumber, c.model, c.currentContract ? t("busyUntil", { date: day(c.currentContract.endDay) }) : null].filter(Boolean).join(" · ")}
              </option>
            ))}
          </NativeSelect>
          {car ? (
            <p className="text-sm text-muted-foreground">{car.driverName ? t("driverIs", { name: car.driverName }) : t("noDriverOnCar")}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label required>{t("clientLabel")}</Label>
          <ClientPicker service={service} value={client} onChange={setClient} />
        </div>
      </section>

      <section className={section}>
        <ContractTermsFields terms={terms} onChange={setTerms} />
      </section>

      <section className={section}>
        <h2 className="font-medium">{t("firstPaymentTitle")}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="contract-paid-now">{t("amountLabel")}</Label>
            <MoneyInput id="contract-paid-now" currency="USD" valueMinor={paidNow} onCommit={setPaidNow} className="h-11" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="contract-paid-method">{t("methodLabel")}</Label>
            <NativeSelect id="contract-paid-method" value={method} onChange={(e) => setMethod(e.target.value as TransportPaymentMethod)} className="h-11 w-full">
              {TRANSPORT_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`methods.${m}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="contract-paid-on">{t("paidOnLabel")}</Label>
            <Input id="contract-paid-on" type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} className="h-11" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("firstPaymentHint")}</p>
      </section>

      <section className={section}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="contract-note">{t("noteLabel")}</Label>
          <textarea id="contract-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className={TEXTAREA_CLASS} />
        </div>
      </section>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={submitting} className="min-h-12">
        {submitting ? t("saving") : t("create")}
      </Button>
    </form>
  );
}
