"use client";

import { useSyncExternalStore } from "react";
import {
  isBusinessUnitKey,
  type BusinessUnitKey,
} from "../../convex/lib/businessUnits";

/**
 * Remembers the last service the user entered, per browser. The URL
 * (/[service]/...) is always the source of truth for the *current*
 * service; this only powers conveniences like "Back to Hair" on admin
 * pages and highlighting the last-used card on the picker. Storage can be
 * unavailable (private mode, blocked site data), so every access is
 * guarded and the store falls back to in-memory.
 */
const STORAGE_KEY = "chirhuza.lastService";
const listeners = new Set<() => void>();
let current: BusinessUnitKey | null | undefined;

function readStorage(): BusinessUnitKey | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && isBusinessUnitKey(value) ? value : null;
  } catch {
    return null;
  }
}

function getSnapshot(): BusinessUnitKey | null {
  if (current === undefined) {
    current = readStorage();
  }
  return current;
}

function getServerSnapshot(): BusinessUnitKey | null {
  return null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      current = readStorage();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setLastService(key: BusinessUnitKey) {
  if (current === key) {
    return;
  }
  current = key;
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Storage unavailable - keep the in-memory value.
  }
  listeners.forEach((listener) => listener());
}

export function useLastService(): BusinessUnitKey | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
