/**
 * Jurisdiction-aware handling for CA practice data.
 *
 * CA work is jurisdiction-bound: the books a firm must retain, the identifiers
 * it must protect, and whether client data may leave the country are all set by
 * statute, not by the product. Rather than scattering `if (india)` branches
 * across the codebase, every engagement carries a jurisdiction code and this
 * registry resolves the concrete rules the rest of the app needs:
 *
 *   - a retention floor (how long books / working papers must be kept),
 *   - the sensitive-identifier schemes in force,
 *   - whether cross-border transfer requires explicit client consent,
 *   - the statutory bases, cited so a reviewer can check the claim.
 *
 * The registry is intentionally data-only and dependency-free: it is imported
 * by the server modules AND by the pure unit tests, so it must not touch the
 * database or the environment.
 *
 * SCOPE AND HONESTY: these are conservative, citable floors, not legal advice.
 * A firm's own retention policy or a client instruction can be longer, never
 * shorter; `retentionFloorDays()` is the minimum the product will enforce.
 */

export interface JurisdictionProfile {
  code: string;
  name: string;
  currency: string;
  /**
   * Retention floor for accounting books (Companies Act 2013 s.128 → 8 FYs).
   * Stored in years in the registry; `retentionFloorDays` converts.
   */
  booksRetentionYears: number;
  /** Retention floor for audit working papers / engagement file. */
  workingPaperRetentionYears: number;
  /** GST records retention, in months (CGST Act s.36 → 72 months). */
  gstRetentionMonths: number;
  /** Taxpayer/business identifier schemes recognized in this jurisdiction. */
  identifierSchemes: string[];
  /** Redact taxpayer identifiers by default unless the caller may see them. */
  redactTaxpayerIdsByDefault: boolean;
  /** Cross-border transfer of personal/taxpayer data requires explicit consent. */
  crossBorderConsentRequired: boolean;
  /** Human-readable statutory bases for the retention floors. */
  retentionBases: string[];
}

/** India — the default and, today, the only fully modelled jurisdiction. */
const IN: JurisdictionProfile = {
  code: "IN",
  name: "India",
  currency: "INR",
  booksRetentionYears: 8, // Companies Act 2013, s.128(5)
  workingPaperRetentionYears: 8, // SA 230 file retained with the engagement record
  gstRetentionMonths: 72, // CGST Act 2017, s.36
  identifierSchemes: ["PAN", "GSTIN", "TAN", "CIN", "DIN", "AADHAAR", "IFSC"],
  redactTaxpayerIdsByDefault: true,
  crossBorderConsentRequired: true,
  retentionBases: [
    "Companies Act 2013 s.128(5) — books of account: 8 financial years",
    "CGST Act 2017 s.36 — GST records: 72 months from the due date of the annual return",
    "Income-tax Act 1961 s.44AA — books where applicable: 6 years from the end of the relevant AY",
    "SA 230 — audit documentation retained with the engagement file",
  ],
};

/**
 * The registry. A jurisdiction NOT listed here is treated as "unknown", which
 * fails safe: taxpayer IDs stay redacted, cross-border transfer needs consent,
 * and the retention floor is the strictest known value (the India floors).
 */
export const JURISDICTIONS: Record<string, JurisdictionProfile> = { IN };

/** Sentinel used for a jurisdiction code with no registered profile. */
export const UNKNOWN_JURISDICTION: JurisdictionProfile = {
  ...IN,
  code: "??",
  name: "Unrecognized jurisdiction",
  retentionBases: [
    "No registered jurisdiction profile — the strictest known retention floor applies and cross-border transfer requires consent.",
  ],
};

/** Resolve a profile by code (case-insensitive); unknown codes fail safe. */
export function jurisdictionProfile(code: string | null | undefined): JurisdictionProfile {
  const key = (code ?? "").trim().toUpperCase();
  return JURISDICTIONS[key] ?? UNKNOWN_JURISDICTION;
}

/** Is this a registered jurisdiction? Unknown codes are handled but flagged. */
export function isKnownJurisdiction(code: string | null | undefined): boolean {
  return Boolean(JURISDICTIONS[(code ?? "").trim().toUpperCase()]);
}

const DAY_MS = 86_400_000;

/**
 * The retention floor for an engagement's records, in days. `kind` selects the
 * books floor (statutory books) or the working-paper floor; GST records use the
 * monthly floor when it is longer.
 */
export function retentionFloorDays(
  code: string | null | undefined,
  kind: "books" | "working-paper" = "working-paper",
): number {
  const p = jurisdictionProfile(code);
  const years = kind === "books" ? p.booksRetentionYears : p.workingPaperRetentionYears;
  const fromYears = Math.round(years * 365.25);
  const fromGst = Math.round((p.gstRetentionMonths / 12) * 365.25);
  return Math.max(fromYears, fromGst);
}

/**
 * The earliest instant a routine purge may run for records created at `from`.
 * This is a *floor*: an explicit firm retention override may extend it, and a
 * legal hold suspends it entirely (checked in lib/server/data-controls.ts).
 */
export function retentionUntilFor(
  code: string | null | undefined,
  from: Date,
  opts?: { kind?: "books" | "working-paper"; overrideDays?: number | null },
): Date {
  const floor = retentionFloorDays(code, opts?.kind ?? "working-paper");
  const override = opts?.overrideDays ?? null;
  const days = override !== null && Number.isFinite(override) ? Math.max(floor, Math.floor(override)) : floor;
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Is an export from `sourceCode` to `targetCode` a cross-border transfer, and
 * does it need explicit consent? Domestic transfers never do. An unknown target
 * code is treated as cross-border (fail safe).
 */
export function crossBorderTransfer(
  sourceCode: string | null | undefined,
  targetCode: string | null | undefined,
): { crossBorder: boolean; consentRequired: boolean } {
  const source = (sourceCode ?? "").trim().toUpperCase();
  const target = (targetCode ?? "").trim().toUpperCase();
  if (!target || target === source) return { crossBorder: false, consentRequired: false };
  const profile = jurisdictionProfile(source);
  return { crossBorder: true, consentRequired: profile.crossBorderConsentRequired };
}

/** List the registered jurisdictions for UI pickers. */
export function listJurisdictions(): JurisdictionProfile[] {
  return Object.values(JURISDICTIONS);
}
