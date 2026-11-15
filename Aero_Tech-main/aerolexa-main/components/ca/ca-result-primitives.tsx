"use client";

import { Info } from "lucide-react";

import { formatInr } from "@/lib/engine/india-tax";

/**
 * Shared result primitives for every CA panel.
 *
 * These were copy-pasted into each CA workspace (and had already started to
 * drift), so a formatting or labelling fix had to be made in several places.
 * One definition, imported everywhere, keeps the money rendering — and the
 * rupee/paise unit caveat that goes with it — identical across panels.
 */

/** Parse a form string to a finite number, defaulting to 0. */
export function parseAmount(v: string): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * One money row in a result card. `value` is INTEGER PAISE (the unit every
 * non-ITR CA engine returns); the ITR engine is rupee-native, so its render
 * sites convert before they get here.
 */
export function Money({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span
        className={`tabular-nums ${
          tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : "font-medium text-foreground"
        }`}
      >
        {formatInr(value)}
      </span>
    </div>
  );
}

/** The engine's own computation trail, collapsed behind a summary. */
export function Method({ steps }: { steps: string[] }) {
  if (!steps?.length) return null;
  return (
    <details className="mt-4 rounded-md border border-line bg-surface-2/40 p-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">How was this calculated?</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-caption text-muted">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

/** Engine warnings, rendered as an amber list. */
export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-3 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-caption text-amber-700 dark:text-amber-400">
      {items.map((w, i) => (
        <li key={i}>{w}</li>
      ))}
    </ul>
  );
}

/** Error line for a failed compute call. */
export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

/**
 * The CA forms open pre-filled so a first computation works in one click. That
 * is useful for a demo and dangerous for a real client file, so the workspace
 * says it plainly: replace the figures before relying on a result.
 */
export function SampleDataNotice() {
  return (
    <p
      role="note"
      className="mb-4 flex items-start gap-2 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-caption text-muted"
    >
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        These forms open with <strong className="text-foreground">illustrative sample values</strong> so a first
        computation runs in one click. Replace every figure with your client&apos;s data before relying on any result —
        nothing here is saved or filed.
      </span>
    </p>
  );
}
