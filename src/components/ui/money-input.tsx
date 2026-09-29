"use client"

import * as React from "react"
import { minorToInput, parseMoneyToMinor } from "../../../convex/lib/money"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * Money entry in major units ("12.50") that reports integer minor units
 * (cents, per CLAUDE.md "Money"). Commits on blur / Enter - suited to
 * autosave. Empty commits `null`. Invalid input is flagged and not
 * committed.
 */
function MoneyInput({
  valueMinor,
  onCommit,
  currency,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> & {
  valueMinor: number | null | undefined
  onCommit: (minor: number | null) => void
  currency: string
}) {
  const format = (minor: number | null | undefined) =>
    minor === null || minor === undefined ? "" : minorToInput(minor)
  const [draft, setDraft] = React.useState(format(valueMinor))
  const [shown, setShown] = React.useState(valueMinor)
  const [invalid, setInvalid] = React.useState(false)

  // Follow server updates.
  if (valueMinor !== shown) {
    setShown(valueMinor)
    setDraft(format(valueMinor))
    setInvalid(false)
  }

  function commit() {
    if (draft.trim() === "") {
      setInvalid(false)
      if (valueMinor !== null && valueMinor !== undefined) onCommit(null)
      return
    }
    const minor = parseMoneyToMinor(draft)
    if (minor === null) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (minor !== valueMinor) onCommit(minor)
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        {...props}
        type="text"
        inputMode="decimal"
        value={draft}
        aria-invalid={invalid || props["aria-invalid"] || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        className="pr-12 tabular-nums"
      />
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
        {currency}
      </span>
    </div>
  )
}

export { MoneyInput }
