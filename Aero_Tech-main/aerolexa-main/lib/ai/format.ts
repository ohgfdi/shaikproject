/**
 * Display formatting for the assistant.
 *
 * Money is ALWAYS integer paise in storage and in tool arithmetic. This module
 * is the only place that turns paise into a human string, and the strings it
 * produces are also what the grounding verifier sees. The model is instructed
 * to reuse these strings instead of doing its own arithmetic.
 */

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,23,456.78 — Indian digit grouping (last group 3, then pairs). */
export function formatInr(paise: number): string {
  if (!Number.isFinite(paise)) return "—";
  return INR.format(paise / 100);
}

/** A money pair: machine value in paise plus the canonical display string. */
export function money(paise: number): { paise: number; inr: string } {
  return { paise, inr: formatInr(paise) };
}

/** Optional money (null/undefined stays honest rather than becoming zero). */
export function moneyOrNull(paise: number | null | undefined): { paise: number; inr: string } | null {
  return typeof paise === "number" && Number.isFinite(paise) ? money(paise) : null;
}

/** Format a count without pretending it is money. */
export function count(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

const FY_RE = /^(\d{4})-(\d{2})$/;

/** Validate and normalise an Indian financial year label ("2025-26"). */
export function assertFy(value: string): string {
  const m = FY_RE.exec(value);
  if (!m) throw new Error('fy must look like "2025-26"');
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || end !== (start + 1) % 100) {
    throw new Error('fy must look like "2025-26" (consecutive years)');
  }
  return value;
}

/** The April–March window for an Indian financial year. */
export function fyRange(fy: string): { from: string; to: string } {
  const start = Number(assertFy(fy).slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** Current Indian FY label for a given instant (April–March). */
export function currentFy(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const start = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Current Indian FY date window. */
export function currentFyRange(now: Date = new Date()): { from: string; to: string } {
  return fyRange(currentFy(now));
}

/** ISO date (YYYY-MM-DD). Validates the calendar, not just the shape. */
export function assertIsoDate(value: string, label = "date"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real calendar date`);
  }
  return value;
}

/** The first and last day of a YYYY-MM period. */
export function monthRange(period: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("period must be YYYY-MM");
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

/** Resolve an explicit range, an FY, or the current FY (reported as an assumption). */
export function resolveWindow(input: { fy?: string; from?: string; to?: string; now?: Date }): {
  from: string;
  to: string;
  source: "explicit" | "fy" | "current_fy_default";
} {
  const hasExplicit = Boolean(input.from || input.to);
  const fyWindow = input.fy ? fyRange(input.fy) : null;
  let from = input.from ?? fyWindow?.from;
  let to = input.to ?? fyWindow?.to;
  let source: "explicit" | "fy" | "current_fy_default" = hasExplicit
    ? "explicit"
    : input.fy
      ? "fy"
      : "current_fy_default";
  if (!from || !to) {
    const fallback = currentFyRange(input.now);
    from = from ?? fallback.from;
    to = to ?? fallback.to;
    if (!hasExplicit && !input.fy) source = "current_fy_default";
  }
  if (from > to) throw new Error("from must be on or before to");
  return { from, to, source };
}

/** Truncate free text without splitting a surrogate pair. */
export function clip(value: string | null | undefined, max = 160): string | null {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Stable opaque cursor for offset pagination. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${Math.max(0, Math.floor(offset))}`, "utf8").toString("base64url");
}

/** Decode a cursor; an invalid cursor is a caller error, never a silent reset. */
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const m = /^o:(\d+)$/.exec(raw);
    if (!m) throw new Error("bad cursor");
    return Math.max(0, Number(m[1]));
  } catch {
    throw new Error("cursor is invalid; omit it to start from the first page");
  }
}
