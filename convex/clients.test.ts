import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { insertUserWithRole, seedReferenceDataForTest } from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");

type Fields = Partial<{
  kind: "company" | "person";
  contactName: string;
  phone: string;
  email: string;
  address: string;
  note: string;
}>;

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const chief = await insertUserWithRole(t, "chief_admin", { email: "chief@x.com", name: "Chief" });
  const manager = await insertUserWithRole(t, "manager_admin", { email: "mgr@x.com", name: "Manager" });
  const as = (user: Id<"users">) => t.withIdentity({ subject: user });
  const add = (name: string, fields: Fields = {}, who = chief) =>
    as(who).mutation(api.clients.create, { businessUnitKey: "transport", kind: fields.kind ?? "company", name, ...fields });
  const audits = () =>
    t.run((ctx) => ctx.db.query("auditLogs").collect()).then((rows) => rows.filter((r) => r.entityTable === "clients"));
  return { t, chief, manager, as, add, audits };
}

test("the Chief Admin saves companies and people; only the name is required", async () => {
  const s = await setup();
  const mining = await s.add("  Kamoto   Mining ", {
    contactName: "Grace Ilunga",
    phone: "+243 970 000 001",
    email: " Grace@Kamoto.CD ",
    address: "Kolwezi",
  });
  await s.add("Patrick Mwamba", { kind: "person" });

  const list = await s.as(s.chief).query(api.clients.list, { businessUnitKey: "transport" });
  expect(list.map((c) => [c.name, c.kind])).toEqual([
    ["Kamoto Mining", "company"],
    ["Patrick Mwamba", "person"],
  ]);
  expect(list[0]).toMatchObject({ _id: mining, email: "grace@kamoto.cd", balance: 0, currency: "USD" });
  expect((await s.audits())[0]).toMatchObject({
    action: "create",
    after: { name: "Kamoto Mining", kind: "company", contactName: "Grace Ilunga", balanceAmount: 0, currency: "USD" },
  });

  // Permissions and services.
  await expect(s.add("Other", {}, s.manager)).rejects.toThrow(/transport\.contracts\.manage/);
  await expect(s.as(s.manager).query(api.clients.list, { businessUnitKey: "transport" })).rejects.toThrow(/transport\.view/);
  await expect(s.as(s.chief).query(api.clients.list, { businessUnitKey: "hair" })).rejects.toThrow(/no cars/);
  // Checks.
  await expect(s.add("  ")).rejects.toThrow(/name is required/);
  await expect(s.add("Bad Mail", { email: "not-an-email" })).rejects.toThrow(/email address isn't valid/);
});

test("one client per name: a duplicate is refused with the existing client's id", async () => {
  const s = await setup();
  const mining = await s.add("Kamoto Mining");
  const error = await s.add("kamoto   MINING").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as ConvexError<{ code: string; clientId: string }>).data).toMatchObject({
    code: "DUPLICATE_CLIENT",
    clientId: mining,
  });
});

test("search by name, contact person or phone", async () => {
  const s = await setup();
  await s.add("Kamoto Mining", { contactName: "Grace Ilunga", phone: "0970000001" });
  await s.add("Patrick Mwamba", { kind: "person" });
  const search = (query: string) =>
    s.as(s.chief).query(api.clients.search, { businessUnitKey: "transport", query }).then((r) => r.map((c) => c.name));
  expect(await search("kamoto")).toEqual(["Kamoto Mining"]);
  expect(await search("Grace")).toEqual(["Kamoto Mining"]);
  expect(await search("0970000001")).toEqual(["Kamoto Mining"]);
  expect(await search("patrick")).toEqual(["Patrick Mwamba"]);
  expect(await search("  ")).toEqual([]);
});

test("edits: only changed fields are audited; another client's name is refused", async () => {
  const s = await setup();
  const mining = await s.add("Kamoto Mining", { phone: "0970000001" });
  await s.add("Patrick Mwamba", { kind: "person" });
  const edit = (name: string, fields: Fields = {}) =>
    s.as(s.chief).mutation(api.clients.update, { clientId: mining, kind: "company", name, ...fields });

  await edit("Kamoto Mining", { phone: "0970000001", contactName: "Grace" });
  expect((await s.audits()).at(-1)).toMatchObject({
    action: "update",
    before: { name: "Kamoto Mining", contactName: null },
    after: { name: "Kamoto Mining", contactName: "Grace" },
  });
  // Clearing the phone removes it.
  await edit("Kamoto Mining", { contactName: "Grace" });
  expect(await s.t.run((ctx) => ctx.db.get("clients", mining))).not.toHaveProperty("phone");
  // No change, no entry.
  const before = (await s.audits()).length;
  await edit("Kamoto Mining", { contactName: "Grace" });
  expect(await s.audits()).toHaveLength(before);
  await expect(edit("patrick mwamba")).rejects.toThrow(/already a client/);
});
