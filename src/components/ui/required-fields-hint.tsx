"use client"

import { useTranslations } from "next-intl"

/** "* Required fields" - explains the stars from `<Label required>`. */
function RequiredFieldsHint() {
  const t = useTranslations("Common")
  return (
    <p className="text-xs text-muted-foreground">
      <span className="text-destructive" aria-hidden>
        *
      </span>{" "}
      {t("requiredHint")}
    </p>
  )
}

export { RequiredFieldsHint }
