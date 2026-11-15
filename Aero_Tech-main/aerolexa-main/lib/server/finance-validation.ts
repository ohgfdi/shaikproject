/**
 * Boundary validation for accounting writes.
 *
 * Money is stored as integer minor units (paise). Accepting a fractional
 * amount and silently `Math.round`-ing it moves money without telling anyone,
 * so the store layer refuses it instead. Dates are ISO `yyyy-mm-dd` strings in
 * the schema; validating the shape here keeps lexicographic range queries and
 * statutory period filters honest.
 */

import { ApiError } from "@/lib/auth/guard";

/** Rounding policy for monetary values. */
export type RoundingPolicy = "nearest-rupee" | "round-half-up" | "companies-act" | "it-act";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in `yyyy-mm-dd` form (rejects 2026-02-31). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertIsoDate(value: unknown, label: string): asserts value is string {
  if (!isIsoDate(value)) {
    throw new ApiError(400, "VALIDATION", `${label} must be a valid date in yyyy-mm-dd form.`);
  }
}

/**
 * Require an integer number of paise. Fractional paise, NaN and Infinity are
 * caller errors — the ledger never rounds them silently.
 */
export function assertMinorUnits(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ApiError(400, "VALIDATION", `${label} must be a whole number of paise (integer minor units).`);
  }
}

/** Validate the shared shape of a journal line before the engine sees it. */
export function assertJournalLines(
  lines: unknown,
  label = "lines",
): asserts lines is { accountCode: string; amount: number; narration?: string | null }[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ApiError(400, "VALIDATION", `${label} must be a non-empty array.`);
  }
  lines.forEach((line, i) => {
    if (!line || typeof line !== "object") {
      throw new ApiError(400, "VALIDATION", `${label}[${i}] must be an object.`);
    }
    const candidate = line as { accountCode?: unknown; amount?: unknown };
    if (typeof candidate.accountCode !== "string" || !candidate.accountCode.trim()) {
      throw new ApiError(400, "VALIDATION", `${label}[${i}].accountCode is required.`);
    }
    assertMinorUnits(candidate.amount, `${label}[${i}].amount`);
  });
}

/** Branded paise type — prevents mixing minor units with base currency. */
export type Paise = number;

/** Round a paise value according to the specified policy. */
export function roundPaise(value: number, policy: RoundingPolicy): Paise {
  // Ensure integer paise first
  const intPaise = Math.round(value);
  switch (policy) {
    case "nearest-rupee":
      // Round to nearest whole rupee (100 paise)
      return intPaise - (intPaise % 100);
    case "round-half-up":
      // Standard round-half-up to nearest rupee
      const remainder = intPaise % 100;
      return intPaise + (remainder >= 50 ? 100 - remainder : -remainder);
    case "companies-act":
      // Depreciation per Companies Act: round down to nearest 10 paise
      return intPaise - (intPaise % 10);
    case "it-act":
      // Income Tax Act rounding: nearest rupee
      return intPaise - (intPaise % 100);
    default:
      return intPaise;
  }
}
