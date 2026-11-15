// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { SHELL_MODULES } from "./shell-modules";

/**
 * The features guide (docs/features, CLAUDE.md "Features guide") must
 * cover every live module, in both languages, and its PDFs must be built.
 */
const root = resolve(__dirname, "../..");
const sectionIds = (lang: "en" | "fr") =>
  [...readFileSync(resolve(root, `docs/features/content-${lang}.html`), "utf8").matchAll(/<h2 id="([a-z-]+)"/g)].map((m) => m[1]);

test("every live module has a section, and both languages have the same sections", () => {
  const en = sectionIds("en");
  expect(sectionIds("fr")).toEqual(en);
  const live = SHELL_MODULES.filter((m) => !("comingSoon" in m && m.comingSoon)).map((m) => m.key);
  expect(live.filter((key) => !en.includes(key))).toEqual([]);
});

test("both PDFs are built where the app serves them", () => {
  for (const lang of ["en", "fr"]) {
    expect(existsSync(resolve(root, `public/docs/chirhuza-features-${lang}.pdf`))).toBe(true);
  }
});
