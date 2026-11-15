/**
 * Presentation-layer formatting. Functions accept an optional "locale style"
 * derived from the workspace number-format setting:
 *   - "comma": 1,234.56 (en-US default)
 *   - "dot":   1.234,56 (de-DE)
 *   - "plain": 1234.56   (no group separators)
 * UI never formats numbers inline — always go through these helpers.
 */

export type NumberStyle = "comma" | "dot" | "plain";
export type WorkspaceNumberFormat = NumberStyle;

export interface FormatOptions {
  style?: NumberStyle;
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  compact?: boolean;
}

function localeFor(style: NumberStyle | undefined): string {
  switch (style) {
    case "dot":
      return "de-DE";
    case "plain":
      return "en-US";
    default:
      return "en-US";
  }
}

export function fmtNumber(value: number | null | undefined, options: FormatOptions = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const style = options.style ?? "comma";
  const locale = localeFor(style);
  const fmt = new Intl.NumberFormat(locale, {
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
    minimumFractionDigits: options.minimumFractionDigits,
    notation: options.compact ? "compact" : "standard",
    compactDisplay: "short",
    useGrouping: style !== "plain", // plain = no thousand separators
  });
  return fmt.format(value);
}

export function fmtInteger(value: number | null | undefined, options: FormatOptions = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const style = options.style ?? "comma";
  return new Intl.NumberFormat(localeFor(style), {
    maximumFractionDigits: 0,
    useGrouping: style !== "plain",
  }).format(value);
}

export function fmtPct(value: number | null | undefined, digits = 1, style?: NumberStyle): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${fmtNumber(value, { style, maximumFractionDigits: digits })}%`;
}

export function fmtSignedPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmtPct(value, digits)}`;
}

export function fmtCurrency(value: number | null | undefined, currency = "USD", style?: NumberStyle): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(localeFor(style), {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value);
}

export function fmtDate(value: string | Date | null | undefined, style: NumberStyle = "comma"): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(style === "dot" ? "de-DE" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function timeAgo(value: string | Date, now = new Date()): string {
  const d = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.max(1, Math.round((now.getTime() - d.getTime()) / 1000));
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let remaining = seconds;
  let unitName = "second";
  for (const [size, name] of units) {
    if (remaining < size) {
      unitName = name;
      break;
    }
    remaining /= size;
  }
  const n = Math.floor(remaining);
  return `${n} ${unitName}${n === 1 ? "" : "s"} ago`;
}

/** Small float formatting for axis labels. */
export function fmtAxis(value: number, style?: NumberStyle): string {
  const abs = Math.abs(value);
  // Pass the full magnitude to the compact formatter so 5,000,000 renders as
  // "5M" — dividing first would collapse it to "5".
  if (abs >= 1_000_000) return fmtNumber(value, { style, compact: true });
  if (abs >= 10_000) return fmtNumber(value, { style, compact: true });
  if (abs >= 1_000) return fmtNumber(value, { style, maximumFractionDigits: 0 });
  return fmtNumber(value, { style, maximumFractionDigits: 2 });
}
