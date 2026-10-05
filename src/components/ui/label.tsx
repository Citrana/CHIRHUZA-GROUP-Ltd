"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * Form label. Pass `required` for a field the user must fill in: it adds a
 * red star. The star is visual only - screen readers already announce
 * "required" from the input's own `required` attribute.
 */
function Label({
  className,
  children,
  required = false,
  ...props
}: React.ComponentProps<"label"> & { required?: boolean }) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {required ? (
        <span>
          {children}
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        </span>
      ) : (
        children
      )}
    </label>
  )
}

export { Label }
