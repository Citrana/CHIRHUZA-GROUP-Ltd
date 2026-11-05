"use client";

import {
  isBusinessUnitKey,
  type BusinessUnitKey,
} from "../../convex/lib/businessUnits";
import { createLocalStore } from "./local-store";

/**
 * Remembers the last service the user entered, per browser. The URL
 * (/[service]/...) is always the source of truth for the *current*
 * service; this only powers conveniences like "Back to Hair" on admin
 * pages, the New sale button there, and highlighting the last-used card on
 * the picker.
 */
const store = createLocalStore<BusinessUnitKey | null>(
  "chirhuza.lastService",
  (value) => (value && isBusinessUnitKey(value) ? value : null),
  null,
);

export function setLastService(key: BusinessUnitKey) {
  store.set(key);
}

export function useLastService(): BusinessUnitKey | null {
  return store.use();
}
