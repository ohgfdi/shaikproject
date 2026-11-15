/**
 * Deterministic grounding verifier.
 *
 * The prompt is not the control. After the model produces a structured answer,
 * this module extracts every number, date, financial-year label and identifier
 * from each claim and from the answer body, then checks each token against the
 * tool results the claim cites.
 *
 * Formatting tolerance is deliberate and display-only:
 *  - "₹1,23,456.79" and "1,23,456.79" are the same value;
 *  - a value rounded to whole rupees is accepted when it equals the stored
 *    value rounded to that precision (₹123456.79 → ₹1,23,457);
 *  - "1.25 crore" / "12.5 lakh" are converted before comparison;
 *  - dates may be written ISO, DD/MM/YYYY or "April 2025".
 *
 * Anything else — including a fabricated total, an invented invoice number or
 * an extra date — fails. A failed answer is never shown as verified.
 */

import type { ToolEnvelope } from "@/lib/ai/tools/types";

export interface AnswerClaim {
  text: string;
  result_ids: string[];
}

export interface VerificationFailure {
  kind: "number" | "date" | "identifier" | "citation" | "shape";
  token: string;
  claimIndex: number | null;
  reason: string;
}

export interface VerificationResult {
  ok: boolean;
  failures: VerificationFailure[];
  checked: { numbers: number; dates: number; identifiers: number };
  citedResultIds: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DMY_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
const FY_RE = /\b\d{4}-\d{2}\b/g;
const MONTH_YEAR_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/gi;

// Currency/unit-aware number token. Lookarounds keep digits inside words
// (GSTR-1, Q1, PAN characters) from being treated as figures.
const NUMBER_RE = /(?<![\w])(?:₹|Rs\.?|INR)?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(%|lakhs?|crores?|paise|paisa)?(?![\w])/gi;

const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g;
const TAN_RE = /\b[A-Z]{4}\d{5}[A-Z]\b/g;
const CIN_RE = /\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/g;
const MASKED_RE = /(?:PAN|GSTIN|A\/c|Account|IFSC|TAN|Aadhaar)?\s*[•*xX]{2,}\s*([A-Z0-9]{2,8})\b/g;
const CODE_RE = /(?<![\w/.-])([A-Z][A-Z0-9]*(?:[\/_-][A-Z0-9]+)+|[A-Z]{1,6}[-/]?\d[A-Z0-9\/_-]{1,})/g;

function parseNumber(raw: string, unit: string | undefined): number {
  const n = Number(raw.replace(/,/g, ""));
  const u = (unit ?? "").toLowerCase();
  if (u === "lakh" || u === "lakhs") return n * 100_000;
  if (u === "crore" || u === "crores") return n * 10_000_000;
  if (u === "paise" || u === "paisa") return n / 100;
  return n;
}

function decimalPlaces(raw: string): number {
  const clean = raw.replace(/,/g, "");
  const dot = clean.indexOf(".");
  return dot < 0 ? 0 : clean.length - dot - 1;
}

function sourceText(results: ToolEnvelope[]): string {
  return results.map((r) => JSON.stringify(r)).join("\n");
}

function sourceNumbers(text: string): number[] {
  const values: number[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    values.push(parseNumber(m[1]!, m[2]));
  }
  return values;
}

function numbersMatch(token: number, decimals: number, sources: number[]): boolean {
  const tolerance = 0.5 * 10 ** -decimals + 1e-9;
  return sources.some((s) => Math.abs(s - token) <= tolerance);
}

function extractNumbers(text: string): { raw: string; value: number; decimals: number }[] {
  const stripped = text
    .replace(ISO_DATE_RE, " ")
    .replace(FY_RE, " ")
    .replace(DMY_DATE_RE, " ")
    .replace(MONTH_YEAR_RE, " ");
  const out: { raw: string; value: number; decimals: number }[] = [];
  for (const m of stripped.matchAll(NUMBER_RE)) {
    const raw = m[1]!;
    // A bare zero is rarely a claim; still verify it when written with a unit.
    out.push({ raw, value: parseNumber(raw, m[2]), decimals: decimalPlaces(raw) });
  }
  return out;
}

function extractDates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ISO_DATE_RE)) out.add(m[0]!);
  for (const m of text.matchAll(FY_RE)) out.add(m[0]!);
  for (const m of text.matchAll(DMY_DATE_RE)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      out.add(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  for (const m of text.matchAll(MONTH_YEAR_RE)) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month) out.add(`${m[2]}-${String(month).padStart(2, "0")}`);
  }
  return [...out];
}

function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const re of [PAN_RE, GSTIN_RE, TAN_RE, CIN_RE]) {
    for (const m of text.matchAll(re)) out.add(m[0]!);
  }
  for (const m of text.matchAll(MASKED_RE)) out.add(m[1]!);
  for (const m of text.matchAll(CODE_RE)) {
    const token = m[1]!;
    if (!/\d/.test(token) || !/[A-Z]/.test(token)) continue;
    const compact = token.replace(/[^A-Z0-9]/g, "");
    if (compact.length < 3) continue;
    out.add(token);
  }
  return [...out];
}

function identifierMatches(token: string, sources: string): boolean {
  const normalizedSources = sources.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const compact = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length < 3) return true; // too short to be a meaningful identifier
  return normalizedSources.includes(compact);
}

function dateMatches(token: string, sources: string): boolean {
  if (sources.includes(token)) return true;
  // A month/year claim is supported by any ISO date in that month.
  if (/^\d{4}-\d{2}$/.test(token)) return sources.includes(token) || sources.includes(`${token}-`);
  // An FY claim is supported by its label or by either boundary date.
  const fy = /^(\d{4})-(\d{2})$/.exec(token);
  if (fy) {
    const start = Number(fy[1]);
    return (
      sources.includes(`"${token}"`) || sources.includes(`${start}-04-01`) || sources.includes(`${start + 1}-03-31`)
    );
  }
  return false;
}

function asClaims(value: unknown): { claims: AnswerClaim[]; failure?: VerificationFailure } {
  if (!Array.isArray(value)) {
    return {
      claims: [],
      failure: { kind: "shape", token: "claims", claimIndex: null, reason: "claims must be an array" },
    };
  }
  const claims: AnswerClaim[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i] as Record<string, unknown> | null;
    if (
      !raw ||
      typeof raw.text !== "string" ||
      !Array.isArray(raw.result_ids) ||
      raw.result_ids.some((id) => typeof id !== "string")
    ) {
      return {
        claims,
        failure: {
          kind: "shape",
          token: "claims",
          claimIndex: i,
          reason: "each claim needs a text string and a result_ids string array",
        },
      };
    }
    claims.push({ text: raw.text, result_ids: raw.result_ids as string[] });
  }
  return { claims };
}

export function verifyAnswer(input: {
  answer: unknown;
  claims: unknown;
  results: ReadonlyMap<string, ToolEnvelope>;
}): VerificationResult {
  const failures: VerificationFailure[] = [];
  if (typeof input.answer !== "string" || !input.answer.trim()) {
    return {
      ok: false,
      failures: [{ kind: "shape", token: "answer", claimIndex: null, reason: "answer must be a non-empty string" }],
      checked: { numbers: 0, dates: 0, identifiers: 0 },
      citedResultIds: [],
    };
  }
  const parsed = asClaims(input.claims);
  if (parsed.failure) failures.push(parsed.failure);

  const claims = parsed.claims;
  const citedAll = new Set<string>();
  const citedEnvelopes: ToolEnvelope[] = [];

  claims.forEach((claim, index) => {
    if (claim.result_ids.length === 0) {
      // Citation is only required when the claim actually asserts a fact with
      // a checkable token. A qualitative statement may stand uncited.
      const hasTokens =
        extractNumbers(claim.text).length > 0 ||
        extractDates(claim.text).length > 0 ||
        extractIdentifiers(claim.text).length > 0;
      if (hasTokens) {
        failures.push({
          kind: "citation",
          token: claim.text.slice(0, 80),
          claimIndex: index,
          reason: "claim contains figures/dates/identifiers but cites no tool result",
        });
      }
      return;
    }
    const envelopes: ToolEnvelope[] = [];
    for (const id of claim.result_ids) {
      const found = input.results.get(id);
      if (!found) {
        failures.push({
          kind: "citation",
          token: id,
          claimIndex: index,
          reason: "cited resultId was not produced in this run",
        });
        continue;
      }
      envelopes.push(found);
      citedAll.add(id);
      citedEnvelopes.push(found);
    }
    if (envelopes.length === 0) return;
    const sources = sourceText(envelopes);
    const numbers = extractNumbers(claim.text);
    const dates = extractDates(claim.text);
    const identifiers = extractIdentifiers(claim.text);
    const available = sourceNumbers(sources);

    for (const n of numbers) {
      if (!numbersMatch(n.value, n.decimals, available)) {
        failures.push({
          kind: "number",
          token: n.raw,
          claimIndex: index,
          reason: "value does not appear in the cited tool result(s)",
        });
      }
    }
    for (const d of dates) {
      if (!dateMatches(d, sources)) {
        failures.push({
          kind: "date",
          token: d,
          claimIndex: index,
          reason: "date does not appear in the cited tool result(s)",
        });
      }
    }
    for (const id of identifiers) {
      if (!identifierMatches(id, sources)) {
        failures.push({
          kind: "identifier",
          token: id,
          claimIndex: index,
          reason: "identifier does not appear in the cited tool result(s)",
        });
      }
    }
  });

  // The answer body must also be covered by the union of claim citations.
  const answerSources = sourceText(citedEnvelopes);
  const answerNumbers = extractNumbers(input.answer);
  const answerDates = extractDates(input.answer);
  const answerIdentifiers = extractIdentifiers(input.answer);
  const answerAvailable = sourceNumbers(answerSources);
  if (
    citedEnvelopes.length === 0 &&
    (answerNumbers.length > 0 || answerDates.length > 0 || answerIdentifiers.length > 0)
  ) {
    failures.push({
      kind: "citation",
      token: "answer",
      claimIndex: null,
      reason: "answer contains figures/dates/identifiers but no claim cites a tool result",
    });
  } else {
    for (const n of answerNumbers) {
      if (!numbersMatch(n.value, n.decimals, answerAvailable)) {
        failures.push({
          kind: "number",
          token: n.raw,
          claimIndex: null,
          reason: "value in answer is not covered by any cited tool result",
        });
      }
    }
    for (const d of answerDates) {
      if (!dateMatches(d, answerSources)) {
        failures.push({
          kind: "date",
          token: d,
          claimIndex: null,
          reason: "date in answer is not covered by any cited tool result",
        });
      }
    }
    for (const id of answerIdentifiers) {
      if (!identifierMatches(id, answerSources)) {
        failures.push({
          kind: "identifier",
          token: id,
          claimIndex: null,
          reason: "identifier in answer is not covered by any cited tool result",
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    checked: { numbers: answerNumbers.length, dates: answerDates.length, identifiers: answerIdentifiers.length },
    citedResultIds: [...citedAll],
  };
}

/** Human-readable feedback for the single correction attempt. */
export function describeFailures(result: VerificationResult): string {
  return result.failures
    .slice(0, 8)
    .map((f) => `- ${f.kind} "${f.token}"${f.claimIndex === null ? "" : ` (claim ${f.claimIndex + 1})`}: ${f.reason}`)
    .join("\n");
}
