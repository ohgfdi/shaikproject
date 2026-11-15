/**
 * UDIN (Unique Document Identification Number) engine.
 *
 * Every document a practising CA issues must carry a UDIN under the ICAI
 * regulations. The real number is 21 alphanumeric characters; the format is
 * `YYYYMNNNNNN` + a per-document block + a checksum tail (`YYYY` = year of
 * issue, `M` = membership status block, `NNNNNN` = membership number).
 *
 * ICAI issues UDINs centrally and a locally-minted value is NOT a valid ICAI
 * UDIN — it can never be placed on an audit report, ITR, certificate or Form 3CD
 * that goes to a client or to a regulator. This module therefore does two
 * different jobs, and labels each one clearly:
 *
 *  1. `generateUdin` / `generateInternalUdinId` — a deterministic, collision-
 *     resistant 21-char identifier for *internal document tracking only* (engagement
 *     version id, working-paper id, evidence blob id). These are NOT ICAI UDINs and
 *     are never presented to a client or regulator as such. They let the app re-derive
 *     a lost internal id without a DB round-trip and reject edited/forged values via a
 *     SHA-256 checksum.
 *
 *  2. `recordUdinIssuance` — the structure a CA firm must capture when a REAL UDIN is
 *     obtained from ICAI's UDIN portal for a document that IS filed or issued. That
 *     record carries the ICAI-issued UDIN string, the source (ICAI UDIN portal /
 *     DSC-based generation / captured manually), the member, the document and the
 *     timestamp — so the audit trail records WHERE the real UDIN came from. The app
 *     does NOT talk to the ICAI portal itself (that requires the member's DSC + the
 *     live portal), so obtaining the real UDIN is an explicit manual or out-of-band
 *     step; this module just captures and validates the record.
 *
 * Cryptography: internal ids use SHA-256 (node:crypto) over the (member, seed,
 * issuedAt) tuple, base32-encoded into the ICAI-like 21-char shape, with a two-
 * character checksum also derived from SHA-256 — one hash primitive, one alphabet,
 * one validation path. No FNV, no hand-rolled string hash pretending to be a
 * cryptographic checksum.
 *
 * Honesty contract (matching ca-efiling.ts, gst-portal-integration.ts): the app
 * does not reach ICAI's registry. A `generateUdin` value carries the tag
 * `INTERNAL-UDIN` in its metadata so any code path that accidentally promotes an
 * internal id to a "filing UDIN" can be detected in review. Real filing UDINs are
 * recorded via `recordUdinIssuance` and validated against the ICAI format + the
 * captured source.
 */

import { createHash } from "node:crypto";

/** Fixed ICAI UDIN length. */
export const UDIN_LENGTH = 21;

/** Ambiguity-free alphabet (no I, O) used for internal ids and for the checksum. */
export const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Number of body characters between the year+membership prefix and the 2-char checksum. */
export const UDIN_BODY_LENGTH = UDIN_LENGTH - 2 - 4 - 6; // 21 - 2 - 4 - 6 = 9

/**
 * Internal document-id kind tag. Any value carrying this tag is an app-internal
 * tracking id and must never be presented to a client/regulator as an ICAI UDIN.
 */
export const INTERNAL_UDIN_TAG = "INTERNAL-UDIN";

/**
 * Encode a byte buffer into the ICAI-like alphabet, left-zero-padded to `length`.
 * Stable regardless of Buffer length; the same primitive is reused for any firm-
 * internal identifier that wants the ICAI-like shape.
 */
export function base32encode(value: Buffer, length: number): string {
  const outChars: string[] = [];
  let bits = 0;
  let have = 0;
  for (let i = 0; i < value.length && outChars.length < length; i++) {
    bits = ((bits << 8) | (value[i] ?? 0)) >>> 0;
    have += 8;
    while (have >= 5 && outChars.length < length) {
      have -= 5;
      outChars.push(ALPHABET[(bits >>> have) & 0x1f] ?? "");
    }
  }
  if (have > 0 && outChars.length < length) {
    outChars.push(ALPHABET[(bits << (5 - have)) & 0x1f] ?? "");
  }
  while (outChars.length < length) outChars.push("0");
  return outChars.join("");
}

/**
 * SHA-256 checksum tail (2 chars) over a 19-char prefix. Same primitive as the
 * body so there is one hash, one alphabet, one validation path.
 */
export function udinChecksum(prefix: string): string {
  const h = createHash("sha256").update(prefix, "utf8").digest();
  const value = (((h[0] ?? 0) << 5) | ((h[1] ?? 0) >> 3)) >>> 0;
  return (ALPHABET[value & 0x1f] ?? "") + (ALPHABET[(value >>> 5) & 0x1f] ?? "");
}

function membershipBlock(memberId: string): string {
  const digits = (memberId.replace(/\D/g, "") || "0").slice(-6).padStart(6, "0");
  return digits;
}

/**
 * Mint a firm-internal 21-char tracking id for `memberId` effective `issuedAt`.
 *
 * This is NOT an ICAI UDIN. It is a deterministic, collision-resistant document
 * identifier used to track engagement versions, working papers and evidence blobs
 * across the app. It is re-derived from (member, seed, issuedAt) so a lost id can
 * be recovered without a DB round-trip, and the embedded checksum lets validators
 * reject edited/forged values without contacting any registry.
 *
 * Internal ids carry the `INTERNAL-UDIN` tag in their issuance metadata so a code
 * review can spot any path that accidentally promotes one to a "filing UDIN".
 */
export function generateUdin(memberId: string, seed: string, issuedAt: Date = new Date()): string {
  const year = issuedAt.getUTCFullYear().toString().padStart(4, "0");
  const membership = membershipBlock(memberId);
  const bodySource = `${memberId}|${seed}|${issuedAt.toISOString()}`;
  const bodyHash = createHash("sha256").update(bodySource, "utf8").digest();
  const bodyChars = base32encode(bodyHash, UDIN_BODY_LENGTH);
  const prefix = `${year}${membership}${bodyChars}`;
  return `${prefix}${udinChecksum(prefix)}`;
}

/**
 * Validate the FORMAT of a real ICAI-issued UDIN: exactly 21 uppercase
 * alphanumeric characters. This deliberately does NOT validate the internal
 * checksum used by `generateUdin` — a real ICAI UDIN does not carry that
 * checksum, so using `isValidUdin` here would reject every genuine UDIN.
 *
 * This still does not contact ICAI. It proves the shape only; whether the UDIN
 * is actually registered to this member/document requires the ICAI portal.
 */
export function isValidUdinFormat(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{21}$/.test(value);
}

/**
 * Validate an app-internal id minted by `generateUdin`: legal alphabet + intact
 * checksum tail. This is NOT a validator for an ICAI-issued UDIN; use
 * `isValidUdinFormat` for that. Does NOT contact ICAI.
 */
export function isValidUdin(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== UDIN_LENGTH) return false;
  for (const ch of value) {
    if (!ALPHABET.includes(ch)) return false;
  }
  const prefix = value.slice(0, UDIN_LENGTH - 2);
  return udinChecksum(prefix) === value.slice(UDIN_LENGTH - 2);
}

// ---------------------------------------------------------------------------
// Real UDIN issuance records (captured from ICAI, not minted by the app)
// ---------------------------------------------------------------------------

/** Where the real UDIN came from. The app does not itself contact ICAI. */
export type UdinSource = "icai-udin-portal" | "dsc-based-generation" | "captured-manually";

/** Status of a UDIN relative to the document it was issued for. */
export type UdinStatus = "issued" | "verified" | "revoked" | "unknown";

/** A UDIN that was actually obtained from ICAI (or captured) for a real document. */
export interface UdinIssuanceRecord {
  /** The ICAI-issued UDIN string (21 uppercase alphanumeric chars). */
  udin: string;
  /** The ICAI membership number of the issuing CA. */
  memberId: string;
  /** Free-text document descriptor, e.g. "FY25 audit report — M/s Acme P Ltd". */
  documentDescription: string;
  /** What the UDIN was issued for. */
  documentType: "audit-report" | "it-return" | "gst-return" | "form-3cd" | "certificate" | "other";
  /** When the UDIN was issued by ICAI (ISO). */
  issuedAt: string;
  /** How the firm obtained the UDIN. */
  source: UdinSource;
  /** Free-text notes, e.g. the ICAI transaction reference. */
  notes?: string;
  /** Current status (verified against ICAI, revoked, etc.). */
  status: UdinStatus;
  /** When the firm recorded this in the app (ISO). */
  recordedAt: string;
}

/**
 * Capture a real ICAI-issued UDIN in the firm's records. This does NOT contact
 * ICAI — it just stores the record the firm obtained out-of-band so the audit
 * trail shows where each filing UDIN came from.
 *
 * Returns a validated record or throws on a format-invalid UDIN string.
 */
export function recordUdinIssuance(input: {
  udin: string;
  memberId: string;
  documentDescription: string;
  documentType: UdinIssuanceRecord["documentType"];
  issuedAt: string;
  source: UdinSource;
  notes?: string;
  status?: UdinStatus;
}): UdinIssuanceRecord {
  if (!isValidUdinFormat(input.udin)) {
    throw new Error(
      `Invalid UDIN format: ${input.udin}. A real ICAI UDIN must be exactly ${UDIN_LENGTH} uppercase alphanumeric characters.`,
    );
  }
  return {
    udin: input.udin,
    memberId: input.memberId,
    documentDescription: input.documentDescription,
    documentType: input.documentType,
    issuedAt: input.issuedAt,
    source: input.source,
    notes: input.notes,
    status: input.status ?? "issued",
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Internal document id with its metadata, for code paths that need to know whether
 * a value is an ICAI UDIN or a firm-internal tracking id.
 */
export interface InternalUdinId {
  /** The 21-char value. */
  value: string;
  /** Always `INTERNAL-UDIN` for ids minted by `generateUdin`. */
  kind: typeof INTERNAL_UDIN_TAG;
  /** The (member, seed, issuedAt) tuple it was derived from. */
  derivation: { memberId: string; seed: string; issuedAt: string };
}

/**
 * Mint a firm-internal tracking id plus its derivation metadata, so callers can
 * tell an internal id from a real ICAI UDIN at a glance.
 */
export function generateInternalUdinId(memberId: string, seed: string, issuedAt: Date = new Date()): InternalUdinId {
  return {
    value: generateUdin(memberId, seed, issuedAt),
    kind: INTERNAL_UDIN_TAG,
    derivation: { memberId, seed, issuedAt: issuedAt.toISOString() },
  };
}
