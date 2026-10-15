import { createTranslator } from "next-intl";
import { expect, test } from "vitest";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { contractPaperContent, type ContractForPaper } from "./contract-pdf";
import type { Translate } from "./pdf/document";

/** The real messages of the Contracts namespace (ICU plurals included). */
const translator = (messages: typeof en, locale: "en" | "fr"): Translate => {
  const t = createTranslator({ locale, messages, namespace: "Contracts" });
  return (key, values) => t(key as Parameters<typeof t>[0], values);
};

// 18 Oct 2026, 10:00 UTC = 12:00 in Lubumbashi.
const AT = Date.UTC(2026, 9, 18, 10);

function contract(overrides: Partial<ContractForPaper> = {}): ContractForPaper {
  return {
    _id: "c1",
    _creationTime: AT,
    businessUnitId: "u1",
    number: "CONTRACT-00001",
    carId: "car1",
    plateNumber: "234JL",
    carModel: "Land Cruiser",
    clientId: "cl1",
    clientName: "Premiere Urgence",
    client: {
      _id: "cl1",
      kind: "company",
      name: "Premiere Urgence",
      contactName: "Kevin",
      phone: "0983727193",
      email: null,
      address: "Lubumbashi",
    },
    driverId: "d1",
    driverName: "Janvier",
    startDay: "2026-10-18",
    days: 12,
    endDay: "2026-10-29",
    dayRate: 6_000,
    computedTotal: 72_000,
    totalAmount: 72_000,
    amountPaid: 0,
    paymentStatus: "open",
    driverDayRate: 1_500,
    driverPayTotal: 18_000,
    driverPaid: 0,
    currency: "USD",
    createdBy: "u",
    createdAt: AT,
    balance: 72_000,
    payments: [],
    driverPayments: [],
    driverPending: 0,
    driverOwed: 18_000,
    deletePending: false,
    ...overrides,
  } as ContractForPaper;
}

const payment = (amount: number, paidAt: number, kind: "payment" | "reversal" = "payment", method: "cash" | "bank" = "cash") =>
  ({ _id: `p${paidAt}`, amount, paidAt, kind, method, reversed: false, reversalPending: false }) as ContractForPaper["payments"][number];

test("the paper: number, seal, parties, vehicle, period and price; never the driver's pay", () => {
  const content = contractPaperContent(contract(), { t: translator(en, "en"), locale: "en", now: AT });
  expect(content.fileName).toBe("CONTRACT-00001.pdf");
  expect(content.title).toBe("Car hire contract");
  expect(content.seal).toEqual({ ring: "CHIRHUZA GROUP LTD · TRANSPORT", number: "CONTRACT-00001", date: "Oct 18, 2026" });
  expect(content.parties[0]).toMatchObject({ heading: "The company", name: "CHIRHUZA GROUP Ltd" });
  expect(content.parties[1]).toEqual({
    heading: "The client",
    name: "Premiere Urgence",
    lines: ["Company", "Contact: Kevin", "0983727193", "Lubumbashi"],
  });
  expect(content.vehicle.rows).toEqual([
    ["Plate number", "234JL"],
    ["Model", "Land Cruiser"],
    ["Driver", "Janvier"],
  ]);
  expect(content.period.rows).toEqual([
    ["From", "October 18, 2026"],
    ["To", "October 29, 2026"],
    ["Duration", "12 days"],
  ]);
  expect(content.price.rows).toEqual([
    ["Price per day", "$60.00"],
    ["Price per day × 12 days", "$720.00"],
  ]);
  expect(content.price.total).toEqual(["Total agreed", "$720.00"]);
  expect(content.price.reason).toBeNull();
  expect(content.payments).toMatchObject({ rows: [], due: ["Balance due", "$720.00"], settled: null });
  // The client's copy: no driver pay anywhere.
  expect(JSON.stringify(content)).not.toMatch(/180\.00|15\.00/);
  expect(content.footer).toBe("Contract CONTRACT-00001 · issued on Oct 18, 2026");
});

test("a changed total shows its reason; payments oldest first, reversals labelled; paid in full", () => {
  const content = contractPaperContent(
    contract({
      totalAmount: 70_000,
      priceChangeReason: "Long-term client",
      amountPaid: 70_000,
      payments: [payment(30_000, AT + 2 * 86_400_000, "payment", "bank"), payment(50_000, AT), payment(-10_000, AT + 86_400_000, "reversal")],
    }),
    { t: translator(en, "en"), locale: "en", now: AT },
  );
  expect(content.price.total).toEqual(["Total agreed", "$700.00"]);
  expect(content.price.reason).toBe("Agreed total differs from price per day × days: Long-term client");
  expect(content.payments.rows).toEqual([
    ["Oct 18, 2026", "Cash", "$500.00"],
    ["Oct 19, 2026", "Correction (Cash)", "-$100.00"],
    ["Oct 20, 2026", "Bank", "$300.00"],
  ]);
  expect(content.payments.paid).toEqual(["Total paid", "$700.00"]);
  expect(content.payments.settled).toBe("Paid in full");
});

test("in French, with one day", () => {
  const content = contractPaperContent(contract({ days: 1, endDay: "2026-10-18", computedTotal: 6_000, totalAmount: 6_000 }), {
    t: translator(fr as typeof en, "fr"),
    locale: "fr",
    now: AT,
  });
  expect(content.title).toBe("Contrat de location");
  expect(content.period.rows[2]).toEqual(["Durée", "1 jour"]);
  expect(content.parties[1].lines[0]).toBe("Entreprise");
  expect(content.signatures.parties).toEqual(["Pour le client", "Pour CHIRHUZA GROUP Ltd"]);
});
