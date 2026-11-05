"use client";

import { createLocalStore } from "./local-store";

/** Whether the floating New sale button is shown or tucked away, per browser. */
export type NewSaleFabState = "shown" | "hidden";

const store = createLocalStore<NewSaleFabState>(
  "chirhuza.newSaleFab",
  (value) => (value === "hidden" ? "hidden" : "shown"),
  "shown",
);

export const useNewSaleFabState = store.use;
export const setNewSaleFabState = (state: NewSaleFabState) => store.set(state);
