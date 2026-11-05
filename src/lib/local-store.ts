"use client";

import { useSyncExternalStore } from "react";

/**
 * A small per-browser value kept in localStorage and shared live by every
 * component that reads it (and by other tabs, via the `storage` event).
 * Storage can be unavailable (private mode, blocked site data), so every
 * access is guarded and the store falls back to an in-memory value. For
 * per-viewer conveniences only - never for data that must persist.
 */
export function createLocalStore<T>(key: string, parse: (raw: string | null) => T, fallback: T) {
  const listeners = new Set<() => void>();
  let current: T | undefined;

  function read(): T {
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      return fallback;
    }
  }

  function getSnapshot(): T {
    if (current === undefined) {
      current = read();
    }
    return current;
  }

  function getServerSnapshot(): T {
    return fallback;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) {
        current = read();
        listener();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  function set(value: T, serialize: (value: T) => string = String) {
    if (current === value) {
      return;
    }
    current = value;
    try {
      window.localStorage.setItem(key, serialize(value));
    } catch {
      // Storage unavailable - keep the in-memory value.
    }
    listeners.forEach((listener) => listener());
  }

  function use(): T {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  }

  return { use, set, get: getSnapshot };
}
