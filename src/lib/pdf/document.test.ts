import { expect, test } from "vitest";
import { pdfSafe } from "./document";

test("pdfSafe keeps accents and swaps characters the PDF font can't draw", () => {
  expect(pdfSafe("Réquisition · Créée — “ok” 14″ …")).toBe('Réquisition · Créée - "ok" 14" ...');
  expect(pdfSafe("10:15\u202FAM")).toBe("10:15 AM");
  expect(pdfSafe("3\u202F987,00\u00A0$")).toBe("3 987,00\u00A0$");
  expect(pdfSafe("Guangzhou → Goma")).toBe("Guangzhou -> Goma");
});
