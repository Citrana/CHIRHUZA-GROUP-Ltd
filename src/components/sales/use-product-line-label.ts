"use client";

import { useTranslations } from "next-intl";

type ProductLine = {
  productName: string | null;
  lengthInches: number | null;
  sizeName: string | null;
  colourName: string | null;
};

/** A sale line's product as one label: name · length · size · colour. */
export function useProductLineLabel() {
  const tProducts = useTranslations("Products");
  return (line: ProductLine) =>
    [
      line.productName ?? "—",
      line.lengthInches !== null ? tProducts("inches", { inches: line.lengthInches }) : null,
      line.sizeName,
      line.colourName,
    ]
      .filter(Boolean)
      .join(" · ");
}
