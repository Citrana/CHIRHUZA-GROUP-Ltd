import { afterEach, expect, test } from "vitest";
import { createLocalStore } from "./local-store";

const g = globalThis as unknown as { window?: unknown };
const original = g.window;
afterEach(() => {
  g.window = original;
});

function fakeWindow(storage: Partial<Storage>) {
  g.window = { localStorage: storage, addEventListener() {}, removeEventListener() {} };
}

const parse = (v: string | null) => (v === "hidden" ? "hidden" : "shown");

test("reads and parses the stored value", () => {
  fakeWindow({ getItem: () => "hidden" });
  expect(createLocalStore("k", parse, "shown").get()).toBe("hidden");
});

test("falls back when storage is blocked, and keeps the value in memory", () => {
  const blocked = () => {
    throw new Error("blocked");
  };
  fakeWindow({ getItem: blocked, setItem: blocked });
  const store = createLocalStore("k", parse, "shown");
  expect(store.get()).toBe("shown");
  store.set("hidden");
  expect(store.get()).toBe("hidden");
});

test("set writes to storage", () => {
  const saved: Record<string, string> = {};
  fakeWindow({ getItem: (k: string) => saved[k] ?? null, setItem: (k: string, v: string) => void (saved[k] = v) });
  const store = createLocalStore("k", parse, "shown");
  store.set("hidden");
  expect(saved.k).toBe("hidden");
});
