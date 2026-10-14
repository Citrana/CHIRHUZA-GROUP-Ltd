"use client";

import { useId } from "react";
import type { ContractPaperContent, PaperRow } from "@/lib/contract-pdf";
import { cn } from "@/lib/utils";

/**
 * The round stamp: the company around the ring, the contract number and
 * its start date in the middle. Drawn in the brand ink, slightly turned.
 */
export function ContractSeal({ seal, className }: { seal: ContractPaperContent["seal"]; className?: string }) {
  const id = useId();
  const ring = `${seal.ring} · `;
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label={`${seal.ring} ${seal.number} ${seal.date}`} className={cn("-rotate-6 text-primary", className)}>
      <defs>
        <path id={`${id}-ring`} d="M 100,100 m -74,0 a 74,74 0 1,1 148,0 a 74,74 0 1,1 -148,0" />
      </defs>
      <circle cx="100" cy="100" r="95" fill="none" stroke="currentColor" strokeWidth="3.5" />
      <circle cx="100" cy="100" r="88" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="100" cy="100" r="58" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text fill="currentColor" fontSize="13" fontWeight="700" letterSpacing="1.5">
        <textPath href={`#${id}-ring`} textLength={455} lengthAdjust="spacing">
          {ring}
        </textPath>
      </text>
      <text x="100" y="86" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="600" letterSpacing="2">
        ★ ★ ★
      </text>
      <text x="100" y="107" textAnchor="middle" fill="currentColor" fontSize="15" fontWeight="800" fontFamily="ui-monospace, monospace">
        {seal.number.replace(/^CONTRACT-/, "N° ")}
      </text>
      <text x="100" y="126" textAnchor="middle" fill="currentColor" fontSize="10.5" fontWeight="500">
        {seal.date}
      </text>
    </svg>
  );
}

function Rows({ rows }: { rows: PaperRow[] }) {
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <dt className="text-neutral-500">{label}</dt>
          <dd className="text-right font-medium text-neutral-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">{children}</h3>;
}

/**
 * A transport contract laid out like a printed document (the client's
 * copy - no driver pay). The same content goes into the PDF.
 */
export function ContractPaper({ content }: { content: ContractPaperContent }) {
  const { price, payments } = content;
  return (
    <article
      aria-label={`${content.title} ${content.number}`}
      className="relative mx-auto w-full max-w-[820px] overflow-hidden rounded-sm border border-neutral-200 bg-white px-5 pt-8 pb-6 text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_18px_40px_-18px_rgba(0,0,0,0.25)] sm:px-12 sm:pt-12"
    >
      <div aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-primary" />

      {/* Header: the company and the document, the seal on the right */}
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-heading text-xl font-bold tracking-tight text-primary sm:text-2xl">{content.company.name}</p>
          {content.company.details.map((line) => (
            <p key={line} className="text-xs text-neutral-500">
              {line}
            </p>
          ))}
          <p className="mt-5 text-[11px] font-semibold tracking-[0.18em] text-neutral-500 uppercase">{content.kicker}</p>
          <h2 className="font-heading text-2xl font-bold sm:text-3xl">{content.title}</h2>
          <p className="mt-1 font-mono text-sm text-neutral-600">{content.number}</p>
        </div>
        <ContractSeal seal={content.seal} className="size-24 shrink-0 sm:size-32" />
      </header>

      <div aria-hidden className="my-6 border-t-2 border-b border-neutral-900/80 py-px sm:my-8" />

      {/* The parties */}
      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        {content.parties.map((party) => (
          <div key={party.heading}>
            <Heading>{party.heading}</Heading>
            <p className="font-semibold">{party.name}</p>
            {party.lines.map((line) => (
              <p key={line} className="text-sm text-neutral-600">
                {line}
              </p>
            ))}
          </div>
        ))}
      </section>

      {/* The vehicle and the period */}
      <section className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <Heading>{content.vehicle.title}</Heading>
          <Rows rows={content.vehicle.rows} />
        </div>
        <div>
          <Heading>{content.period.title}</Heading>
          <Rows rows={content.period.rows} />
        </div>
      </section>

      {/* The price */}
      <section className="mt-8">
        <Heading>{price.title}</Heading>
        <Rows rows={price.rows} />
        <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-neutral-900 pt-2">
          <span className="font-semibold">{price.total[0]}</span>
          <span className="text-lg font-bold tabular-nums">{price.total[1]}</span>
        </div>
        {price.reason ? <p className="mt-1 text-xs text-neutral-500 italic">{price.reason}</p> : null}
      </section>

      {/* Payments received */}
      <section className="mt-8">
        <Heading>{payments.title}</Heading>
        {payments.rows.length === 0 ? (
          <p className="text-sm text-neutral-500 italic">{payments.empty}</p>
        ) : (
          <div role="table" className="text-sm">
            <div role="row" className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-neutral-300 pb-1 text-xs text-neutral-500">
              {payments.head.map((cell, i) => (
                <span key={cell} role="columnheader" className={cn(i === 2 && "text-right")}>
                  {cell}
                </span>
              ))}
            </div>
            {payments.rows.map((row, index) => (
              <div key={index} role="row" className="grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-dashed border-neutral-200 py-1.5">
                {row.map((cell, i) => (
                  <span key={i} role="cell" className={cn(i === 2 && "text-right tabular-nums")}>
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="relative mt-3 ml-auto flex w-full max-w-xs flex-col gap-1 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-neutral-500">{payments.paid[0]}</span>
            <span className="font-medium tabular-nums">{payments.paid[1]}</span>
          </div>
          <div className="flex justify-between gap-4 border-t border-neutral-900 pt-1">
            <span className="font-semibold">{payments.due[0]}</span>
            <span className={cn("font-bold tabular-nums", !payments.settled && "text-destructive")}>{payments.due[1]}</span>
          </div>
          {payments.settled ? (
            <span className="absolute -top-2 -left-28 hidden -rotate-12 rounded border-2 border-[color:var(--chart-2)] px-2 py-0.5 text-xs font-bold tracking-widest text-[color:var(--chart-2)] uppercase sm:block">
              {payments.settled}
            </span>
          ) : null}
        </div>
        {payments.settled ? (
          <p className="mt-2 text-right text-xs font-bold tracking-widest text-[color:var(--chart-2)] uppercase sm:hidden">{payments.settled}</p>
        ) : null}
      </section>

      {content.note ? (
        <section className="mt-8">
          <Heading>{content.note[0]}</Heading>
          <p className="text-sm whitespace-pre-line">{content.note[1]}</p>
        </section>
      ) : null}

      {/* Signatures */}
      <section className="mt-10">
        <Heading>{content.signatures.title}</Heading>
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
          {content.signatures.parties.map((party) => (
            <div key={party} className="flex flex-col gap-1">
              <span className="text-sm font-semibold">{party}</span>
              <span aria-hidden className="mt-12 border-b border-neutral-900" />
              <span className="text-xs text-neutral-500">{content.signatures.hint}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-10 border-t border-neutral-200 pt-3 text-center text-[11px] text-neutral-400">{content.footer}</footer>
    </article>
  );
}
