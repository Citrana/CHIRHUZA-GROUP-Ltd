import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

test("ping reports ok", async () => {
  const t = convexTest(schema, modules);
  const result = await t.query(api.healthCheck.ping, {});
  expect(result.ok).toBe(true);
  expect(typeof result.time).toBe("number");
});
