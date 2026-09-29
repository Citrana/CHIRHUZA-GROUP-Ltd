import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { APPROVAL_HANDLERS } from "./lib/approvalHandlers";
import { insertApproval, type ApprovalRequest } from "./lib/approvals";
import {
  getBusinessUnitId,
  insertLocation,
  insertUserWithRole,
  seedReferenceDataForTest,
} from "./lib/test.utils";

const modules = import.meta.glob("./**/*.*s");
const PAGE = { numItems: 50, cursor: null };

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const t = convexTest(schema, modules);
  await seedReferenceDataForTest(t);
  const hairId = await getBusinessUnitId(t, "hair");
  const shopA = await insertLocation(t, { name: "Shop A" });
  const shopB = await insertLocation(t, { name: "Shop B" });
  // Sales Agents can request; they hold withdrawals.approve at own_location only.
  const agentA = await insertUserWithRole(t, "sales_agent", { email: "a@x.com", name: "Agent A", locationId: shopA });
  const agentB = await insertUserWithRole(t, "sales_agent", { email: "b@x.com", name: "Agent B", locationId: shopB });
  // Chief Admin: expenses.approve + approvals.view_all.
  const chief = await insertUserWithRole(t, "chief_admin", { email: "c@x.com", name: "Chief" });
  // Manager Admin: no expenses.approve, no view_all.
  const manager = await insertUserWithRole(t, "manager_admin", { email: "m@x.com", name: "Manager" });
  return { t, hairId, shopA, shopB, agentA, agentB, chief, manager };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function request(
  s: Setup,
  requestedBy: Id<"users">,
  overrides: Partial<ApprovalRequest> = {},
) {
  return s.t.run((ctx) =>
    insertApproval(ctx, requestedBy, {
      type: "expense",
      businessUnitId: s.hairId,
      entityTable: "test",
      entityId: `rec-${Math.random()}`,
      payload: { before: { amountMinor: 100 }, after: { amountMinor: 200 } },
      reason: "Please approve",
      ...overrides,
    }),
  );
}

const getApproval = (s: Setup, id: Id<"approvals">) =>
  s.t.run((ctx) => ctx.db.get("approvals", id));

const auditFor = (s: Setup, id: Id<"approvals">) =>
  s.t.run((ctx) =>
    ctx.db
      .query("auditLogs")
      .withIndex("by_entityTable_and_entityId_and_timestamp", (q) =>
        q.eq("entityTable", "approvals").eq("entityId", id),
      )
      .collect(),
  );

test("requesting creates a pending approval and a create audit entry", async () => {
  const s = await setup();
  const id = await request(s, s.agentA);

  expect(await getApproval(s, id)).toMatchObject({
    status: "pending",
    type: "expense",
    requestedBy: s.agentA,
    requiredPermission: "expenses.approve",
    reason: "Please approve",
  });
  const audit = await auditFor(s, id);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    action: "create",
    actorId: s.agentA,
    businessUnitId: s.hairId,
    after: { type: "expense", status: "pending" },
  });
});

test("a second pending request of the same type for the same record is rejected", async () => {
  const s = await setup();
  await request(s, s.agentA, { entityId: "same" });
  await expect(request(s, s.agentB, { entityId: "same" })).rejects.toThrow(
    /already pending/,
  );
  // A different type for the same record is fine.
  await request(s, s.agentB, { entityId: "same", type: "delete" });
});

test("approving as a different user with the permission runs the handler and is audited", async () => {
  const s = await setup();
  const handler = vi.spyOn(APPROVAL_HANDLERS, "expense");
  const id = await request(s, s.agentA);

  await s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
    approvalId: id,
    decision: "approve",
    note: "  Looks fine  ",
  });

  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0][1]).toMatchObject({ _id: id, status: "pending" });
  expect(handler.mock.calls[0][2]).toMatchObject({ _id: s.chief });
  const approval = await getApproval(s, id);
  expect(approval).toMatchObject({
    status: "approved",
    decidedBy: s.chief,
    decisionNote: "Looks fine",
  });
  expect(approval!.decidedAt).toBeTypeOf("number");
  const audit = await auditFor(s, id);
  expect(audit.map((a) => a.action)).toEqual(["create", "approve"]);
  expect(audit[1]).toMatchObject({
    actorId: s.chief,
    before: { status: "pending" },
    after: { status: "approved" },
    reason: "Looks fine",
  });
});

test("rejecting records the decision, is audited, and never runs the handler", async () => {
  const s = await setup();
  const handler = vi.spyOn(APPROVAL_HANDLERS, "expense");
  const id = await request(s, s.agentA);

  await s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
    approvalId: id,
    decision: "reject",
  });

  expect(handler).not.toHaveBeenCalled();
  expect(await getApproval(s, id)).toMatchObject({ status: "rejected", decidedBy: s.chief });
  expect((await auditFor(s, id)).map((a) => a.action)).toEqual(["create", "reject"]);
});

test("nobody can decide their own request, even holding the permission", async () => {
  const s = await setup();
  const id = await request(s, s.chief);
  await expect(
    s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
      approvalId: id,
      decision: "approve",
    }),
  ).rejects.toThrow(/your own request/);
  expect((await getApproval(s, id))!.status).toBe("pending");
});

test("a decider without the required permission is rejected", async () => {
  const s = await setup();
  const id = await request(s, s.agentA);
  await expect(
    s.t.withIdentity({ subject: s.manager }).mutation(api.approvals.decideApproval, {
      approvalId: id,
      decision: "approve",
    }),
  ).rejects.toThrow(/expenses\.approve/);
});

test("an own_location decider can only decide approvals at their location", async () => {
  const s = await setup();
  // withdrawals.approve is own_location for Sales Agents.
  const atShopB = await request(s, s.chief, { type: "withdrawal", locationId: s.shopB });
  const atShopA = await request(s, s.chief, { type: "withdrawal", locationId: s.shopA });
  const asAgentA = s.t.withIdentity({ subject: s.agentA });

  await expect(
    asAgentA.mutation(api.approvals.decideApproval, { approvalId: atShopB, decision: "approve" }),
  ).rejects.toThrow(/outside your scope/);
  await asAgentA.mutation(api.approvals.decideApproval, { approvalId: atShopA, decision: "approve" });
  expect((await getApproval(s, atShopA))!.status).toBe("approved");
});

test("an already-decided approval can't be decided again", async () => {
  const s = await setup();
  const id = await request(s, s.agentA);
  const asChief = s.t.withIdentity({ subject: s.chief });
  await asChief.mutation(api.approvals.decideApproval, { approvalId: id, decision: "reject" });
  await expect(
    asChief.mutation(api.approvals.decideApproval, { approvalId: id, decision: "approve" }),
  ).rejects.toThrow(/already been decided/);
});

test("if the handler fails, nothing is applied and the approval stays pending", async () => {
  const s = await setup();
  vi.spyOn(APPROVAL_HANDLERS, "expense").mockRejectedValueOnce(new Error("boom"));
  const id = await request(s, s.agentA);

  await expect(
    s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
      approvalId: id,
      decision: "approve",
    }),
  ).rejects.toThrow(/boom/);
  expect((await getApproval(s, id))!.status).toBe("pending");
  expect((await auditFor(s, id)).map((a) => a.action)).toEqual(["create"]);
});

test("list: view_all sees everything; others see their own requests and what they may decide", async () => {
  const s = await setup();
  const mine = await request(s, s.agentA, { reason: "mine" });
  const othersExpense = await request(s, s.agentB, { reason: "b expense" });
  const withdrawalA = await request(s, s.chief, { type: "withdrawal", locationId: s.shopA });
  const withdrawalB = await request(s, s.chief, { type: "withdrawal", locationId: s.shopB });

  const ids = async (who: Id<"users">, extra: Record<string, unknown> = {}) =>
    (
      await s.t.withIdentity({ subject: who }).query(api.approvals.list, {
        businessUnitKey: "hair",
        paginationOpts: PAGE,
        ...extra,
      })
    ).page.map((a) => a._id);

  expect((await ids(s.chief)).sort()).toEqual(
    [mine, othersExpense, withdrawalA, withdrawalB].sort(),
  );
  // Agent A: own request + the withdrawal at their own shop.
  expect((await ids(s.agentA)).sort()).toEqual([mine, withdrawalA].sort());
  expect(await ids(s.agentA, { requestedByMe: true })).toEqual([mine]);
  expect(await ids(s.chief, { type: "withdrawal" })).toEqual([withdrawalB, withdrawalA]);

  const page = (
    await s.t.withIdentity({ subject: s.agentA }).query(api.approvals.list, {
      businessUnitKey: "hair",
      paginationOpts: PAGE,
    })
  ).page;
  const byId = new Map(page.map((a) => [a._id, a]));
  expect(byId.get(mine)).toMatchObject({ canDecide: false, requesterName: "Agent A" });
  expect(byId.get(withdrawalA)?.canDecide).toBe(true);
});

test("list filters by status and date range", async () => {
  const s = await setup();
  const first = await request(s, s.agentA);
  const second = await request(s, s.agentA);
  await s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
    approvalId: first,
    decision: "approve",
  });
  const asChief = s.t.withIdentity({ subject: s.chief });
  const list = (extra: Record<string, unknown>) =>
    asChief
      .query(api.approvals.list, { businessUnitKey: "hair", paginationOpts: PAGE, ...extra })
      .then((r) => r.page.map((a) => a._id));

  expect(await list({ status: "pending" })).toEqual([second]);
  expect(await list({ status: "approved" })).toEqual([first]);
  const secondDoc = await getApproval(s, second);
  expect(await list({ from: secondDoc!._creationTime })).toEqual([second]);
  expect(await list({ to: secondDoc!._creationTime - 0.001 })).toEqual([first]);
});

test("get hides approvals the user may not see", async () => {
  const s = await setup();
  const id = await request(s, s.agentB);
  expect(
    await s.t.withIdentity({ subject: s.agentA }).query(api.approvals.get, { approvalId: id }),
  ).toBeNull();
  expect(
    await s.t.withIdentity({ subject: s.chief }).query(api.approvals.get, { approvalId: id }),
  ).toMatchObject({ _id: id, canDecide: true });
});

test("pendingCount counts only pending approvals the user can decide", async () => {
  const s = await setup();
  await request(s, s.agentA);
  await request(s, s.agentB);
  await request(s, s.chief); // Chief's own: not counted for Chief.
  const decided = await request(s, s.agentA);
  await s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
    approvalId: decided,
    decision: "reject",
  });

  const count = (who: Id<"users">) =>
    s.t.withIdentity({ subject: who }).query(api.approvals.pendingCount, {
      businessUnitKey: "hair",
    });
  expect(await count(s.chief)).toBe(2);
  expect(await count(s.manager)).toBe(0);
  expect(await count(s.agentA)).toBe(0);
});

test("createTestApproval creates a pending test approval for the given requester", async () => {
  const s = await setup();
  const id = await s.t.mutation(internal.approvals.createTestApproval, {
    requestedByEmail: "a@x.com",
  });
  expect(await getApproval(s, id)).toMatchObject({
    status: "pending",
    type: "expense",
    requestedBy: s.agentA,
    businessUnitId: s.hairId,
    payload: { before: { currency: "CDF" }, after: { currency: "CDF" } },
  });
  await expect(
    s.t.mutation(internal.approvals.createTestApproval, { requestedByEmail: "nobody@x.com" }),
  ).rejects.toThrow(/No user/);
});

test("anonymous callers are rejected", async () => {
  const s = await setup();
  await expect(
    s.t.query(api.approvals.list, { businessUnitKey: "hair", paginationOpts: PAGE }),
  ).rejects.toThrow(/Not authenticated/);
});

test("the Super Admin may decide their own request; it's flagged in the audit", async () => {
  const s = await setup();
  const superAdmin = await insertUserWithRole(s.t, "super_admin", { email: "sa@x.com" });
  const id = await request(s, superAdmin);

  expect(
    await s.t.withIdentity({ subject: superAdmin }).query(api.approvals.pendingCount, { businessUnitKey: "hair" }),
  ).toBe(1);
  await s.t.withIdentity({ subject: superAdmin }).mutation(api.approvals.decideApproval, {
    approvalId: id,
    decision: "approve",
  });

  expect((await getApproval(s, id))!.status).toBe("approved");
  const audit = await auditFor(s, id);
  expect(audit[1]).toMatchObject({ action: "approve", after: { status: "approved", selfApproved: true } });
});

test("a decision on someone else's request isn't flagged as self-approved", async () => {
  const s = await setup();
  const id = await request(s, s.agentA);
  await s.t.withIdentity({ subject: s.chief }).mutation(api.approvals.decideApproval, {
    approvalId: id,
    decision: "approve",
  });
  expect((await auditFor(s, id))[1].after).toEqual({ status: "approved" });
});
