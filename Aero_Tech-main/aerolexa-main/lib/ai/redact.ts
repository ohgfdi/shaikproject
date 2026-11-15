/**
 * Redaction at the tool boundary.
 *
 * The model never needs a full PAN, GSTIN, bank account, IFSC, Aadhaar or
 * phone number to answer an accounting question. Masking happens HERE — before
 * the value is serialised into a tool result, before it reaches Anthropic, and
 * before it is written to the assistant log. Doing it in the prompt would be
 * too late.
 *
 * Reuses the practice layer's identifier scrubber so masking stays consistent
 * with exports and engagement views.
 */

import { redactSensitiveValue, scrubIdentifiersInText } from "@/lib/server/engagement";

const PHONE_RE = /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g;

/** Mask one identifier, keeping only the last four characters. */
export function maskIdentifier(
  category: "pan" | "gstin" | "tan" | "cin" | "din" | "aadhaar" | "bank" | "ifsc",
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const mapped =
    category === "pan"
      ? "pan"
      : category === "gstin"
        ? "gstin"
        : category === "tan"
          ? "tan"
          : category === "cin"
            ? "cin"
            : category === "din"
              ? "din"
              : "bank_account_partial";
  return redactSensitiveValue(mapped, value, false);
}

export function maskPan(value: string | null | undefined): string | null {
  return maskIdentifier("pan", value);
}
export function maskGstin(value: string | null | undefined): string | null {
  return maskIdentifier("gstin", value);
}
export function maskTan(value: string | null | undefined): string | null {
  return maskIdentifier("tan", value);
}
export function maskAccount(value: string | null | undefined): string | null {
  return maskIdentifier("bank", value);
}
export function maskIfsc(value: string | null | undefined): string | null {
  return maskIdentifier("ifsc", value);
}

/**
 * Scrub free text that may contain identifiers (bank narrations, remarks,
 * period-lock reasons). Truncation is the caller's job so the audit log and
 * the model see the same string.
 */
export function scrubText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const once = scrubIdentifiersInText(value);
  return once.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    return `••••••${digits.slice(-4)}`;
  });
}

/** Recursively scrub strings in a structured payload bound for logs. */
export function scrubForLog(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubForLog);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubForLog(inner);
    }
    return out;
  }
  return value;
}
