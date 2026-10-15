"use client";

import { useEffect, useRef, type AnimationEvent } from "react";
import { useTranslations } from "next-intl";
import { QUOTE_KEYS, type CelebrationTier } from "@/lib/sale-celebration";
import { PixelMascot } from "./pixel-mascot";

/** How long the mascot stays (keep in step with `mascot-show` in globals.css). */
const DURATION_MS = 6000;

/**
 * After a sale is saved: the pixel mascot hops into the middle of the
 * screen holding the day's gift, says well done, and leaves. The page stays
 * usable underneath; a tap on the mascot sends it away early.
 */
export function SaleCelebration({
  name,
  units,
  location,
  date,
  tier,
  quote,
  onDone,
}: {
  name: string | null;
  units: number;
  location: string;
  /** null when the sale is for today, else the formatted sale day. */
  date: string | null;
  tier: CelebrationTier;
  quote: number;
  onDone: () => void;
}) {
  const t = useTranslations("SaleCelebration");

  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  // Safety net if the animation never ends (e.g. the tab was hidden).
  useEffect(() => {
    const timer = window.setTimeout(() => done.current(), DURATION_MS + 800);
    return () => window.clearTimeout(timer);
  }, []);

  function ended(e: AnimationEvent) {
    if (e.target === e.currentTarget) onDone();
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        onClick={onDone}
        onAnimationEnd={ended}
        aria-label={t("dismiss")}
        className="mascot-show pointer-events-auto flex max-w-xs flex-col items-center gap-3 text-center"
      >
        <span
          role="status"
          className="mascot-bubble relative rounded-xl border border-border bg-card px-4 py-3 shadow-lg after:absolute after:left-1/2 after:top-full after:-translate-x-1/2 after:border-8 after:border-transparent after:border-t-card"
        >
          <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(`tiers.${tier}`)}</span>
          <span className="block font-heading text-lg font-bold leading-tight text-primary">
            {name ? t("wellDone", { name }) : t("wellDoneNoName")}
          </span>
          <span className="block text-sm">
            {date ? t("soldOn", { units, location, date }) : t("soldToday", { units, location })}
          </span>
          <span className="mt-1 block text-sm italic text-muted-foreground">{t(`quotes.${QUOTE_KEYS[quote]}`)}</span>
        </span>
        <PixelMascot tier={tier} className="h-40 w-auto drop-shadow-sm" />
      </button>
    </div>
  );
}
