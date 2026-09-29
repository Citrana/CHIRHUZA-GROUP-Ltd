import { expect, test } from "vitest";
import { formatAuditValue, summarizeAuditEntry } from "./audit-summary";

test("an update summarizes its first readable change and counts the rest", () => {
  expect(
    summarizeAuditEntry({
      action: "update",
      before: { address: "Av. 12", active: true },
      after: { address: "Av. 14", active: false },
    }),
  ).toEqual({ kind: "change", field: "active", from: true, to: false, more: 1 });
});

test("readable fields win over their raw id twins, which aren't counted", () => {
  expect(
    summarizeAuditEntry({
      action: "update",
      before: { roleId: "r1", role: "sales_agent" },
      after: { roleId: "r2", role: "chief_admin" },
    }),
  ).toEqual({
    kind: "change",
    field: "role",
    from: "sales_agent",
    to: "chief_admin",
    more: 0,
  });
});

test("ids are used only when nothing readable exists", () => {
  expect(
    summarizeAuditEntry({
      action: "update",
      before: { locationId: "l1" },
      after: { locationId: null },
    }),
  ).toMatchObject({ field: "locationId", from: "l1", to: null });
});

test("a create shows the most meaningful field of the new record", () => {
  expect(
    summarizeAuditEntry({
      action: "create",
      after: {
        type: "shop",
        businessUnitId: "b1",
        name: "Boutique la Grace",
        active: true,
      },
    }),
  ).toEqual({ kind: "value", field: "name", value: "Boutique la Grace", more: 0 });
});

test("a delete shows the removed record's most meaningful field", () => {
  expect(
    summarizeAuditEntry({
      action: "delete",
      before: { roleId: "r1", role: "sales_agent", permission: "users.manage" },
    }),
  ).toMatchObject({ kind: "value", field: "permission", value: "users.manage" });
});

test("no snapshots means no summary", () => {
  expect(summarizeAuditEntry({ action: "approve" })).toBeNull();
});

test("formatAuditValue", () => {
  expect(formatAuditValue(null, "—")).toBe("—");
  expect(formatAuditValue(undefined, "—")).toBe("—");
  expect(formatAuditValue(false, "—")).toBe("false");
  expect(formatAuditValue({ a: 1 }, "—")).toBe('{"a":1}');
});
