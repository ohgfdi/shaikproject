/**
 * Statute & notification rule registry — the ingestion + versioning layer that
 * keeps every statutory rate/slab/threshold the CA engines consume current.
 *
 * WHY THIS EXISTS
 * CA work is not a fixed formula library. The actual question a firm answers
 * every filing season is *which rule applies* — this FY, to this entity, in
 * this state, with these notifications in force. The compute engines can take
 * any rate table; what they could not do is show where a number came from, who
 * published it, when it took effect and what it replaced. This module is that
 * missing layer, and it is deliberately pure and deterministic so the same
 * inputs always resolve to the same rule version (an audit has to reproduce).
 *
 * THE MODEL
 *   notification  → an authority's published item (Notification/Circular/…)
 *   rule          → a named slot ("income-tax-slab-new", "tds-194c-rate", …)
 *   rule version  → one value of a slot, with an effective window, a citation,
 *                   the notification it came from, and the version it supersedes
 *
 * Resolution is notification-aware: a version only applies inside its
 * `[effectiveFrom, effectiveTo)` window, and the most *specific* applicability
 * wins (state-specific over all-India, entity-specific over generic), then the
 * latest effectiveFrom, then the highest version. Nothing silently falls back
 * to a different year's rates — an unresolved lookup returns null so the caller
 * must surface "no rule in force" instead of a wrong number.
 *
 * HONESTY CONTRACT
 * The built-in catalogue labels every slot with its authority and cadence, and
 * the date extractor only *proposes* effective dates found in the text. Nothing
 * here is legal advice and nothing is auto-published: a parsed notification
 * produces DRAFT versions that a reviewer must confirm. The reviewer must
 * verify each rule against the current notification before filing.
 */

import { createHash } from "node:crypto";

import type { RateKind, RateTable, SlabRow } from "./ca-rate-registry";

export class StatutesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatutesError";
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Publishing authority a notification comes from. */
export type NotificationAuthority = "cbdt" | "cbic" | "mca" | "rbi" | "epfo" | "gst-council" | "state" | "other";

/** What kind of item was published. */
export type NotificationKind = "notification" | "circular" | "press-release" | "amendment" | "order";

/** Units a rule value is expressed in (no floats — integers only). */
export type RuleUnit = "paise" | "bps" | "amount" | "days" | "months" | "count" | "text";

export type RuleStatus = "draft" | "published" | "superseded";

/** Central rules apply all-India; state rules apply to one or more states. */
export type RuleScope = "central" | "state";

/** One row of a rule table (a slab, a rate, or a single scalar row). */
export interface RuleRow {
  /** Upper bound in the rule's unit; `null` = open-ended (must be last). */
  upTo: number | null;
  /** Rate in bps, or amount in the rule's unit. */
  rate: number;
  /** Optional plain-language label for the row. */
  label?: string;
}

/**
 * Who/what a rule version applies to. Empty arrays mean "any" — an empty
 * `states` is an all-India rule, an empty `entityTypes` applies to every entity
 * form. That is what makes specificity ranking possible (see
 * `compareApplicabilitySpecificity`).
 */
export interface Applicability {
  /** Assessment year ("2026-27"), fiscal year ("2025-26"), or null = any. */
  ay: string | null;
  entityTypes: string[];
  states: string[];
  scope: RuleScope;
}

/** A persisted rule version — one value of a rule slot. */
export interface RuleVersionRecord {
  id: string;
  ruleKey: string;
  version: number;
  applicability: Applicability;
  unit: RuleUnit;
  rows: RuleRow[];
  /** Plain-language value, e.g. "22% + 10% surcharge + 4% cess". */
  valueSummary: string;
  /** Statutory citation the reviewer can check. */
  citation: string;
  /** Inclusive start of the effective window (yyyy-mm-dd). */
  effectiveFrom: string;
  /** Exclusive end of the effective window, or null = in force until superseded. */
  effectiveTo: string | null;
  status: RuleStatus;
  /** Notification this version was derived from (null for built-ins). */
  notificationId: string | null;
  /** Id of the version this one replaces, or null. */
  supersedes: string | null;
  /** SHA-256 of the canonical content (tamper/duplicate detection). */
  contentHash: string;
  createdAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue — the rule slots a firm keeps current, with their authority
// ---------------------------------------------------------------------------

export interface RuleDefinition {
  key: string;
  label: string;
  unit: RuleUnit;
  description: string;
  authority: NotificationAuthority;
  cadence: "annual" | "quarterly" | "ad-hoc";
  /** ca-rate-registry kind this slot feeds, when it is a rate table. */
  rateKind?: RateKind;
  /** Keywords that make a notification impact this slot. */
  keywords: string[];
}

/**
 * The canonical slots. This is the documented answer to "which rules does the
 * app track, and who publishes changes to them" — the UI renders it and the
 * parser matches notification text against it.
 */
export const RULE_CATALOG: readonly RuleDefinition[] = [
  {
    key: "income-tax-slab-new",
    label: "Income-tax slabs (new regime)",
    unit: "paise",
    description: "Resident individual/HUF slab rates under the default (new) regime.",
    authority: "cbdt",
    cadence: "annual",
    rateKind: "individual-slab-new",
    keywords: ["slab", "new regime", "section 115bac", "115bac", "rebate"],
  },
  {
    key: "income-tax-slab-old",
    label: "Income-tax slabs (old regime)",
    unit: "paise",
    description: "Resident individual slab rates under the optional (old) regime.",
    authority: "cbdt",
    cadence: "annual",
    rateKind: "individual-slab-old",
    keywords: ["slab", "old regime", "section 115baa", "rebate"],
  },
  {
    key: "corporate-rate",
    label: "Corporate tax rate",
    unit: "bps",
    description: "Domestic company rates, including s.115BAA / s.115BAB concessional rates.",
    authority: "cbdt",
    cadence: "annual",
    rateKind: "corporate-rate",
    keywords: ["corporate", "company", "115baa", "115bab", "concessional"],
  },
  {
    key: "surcharge",
    label: "Surcharge slabs",
    unit: "bps",
    description: "Surcharge rates by total income band and assessee class.",
    authority: "cbdt",
    cadence: "annual",
    rateKind: "surcharge",
    keywords: ["surcharge"],
  },
  {
    key: "cess",
    label: "Health & education cess",
    unit: "bps",
    description: "Health and education cess levied on tax plus surcharge.",
    authority: "cbdt",
    cadence: "annual",
    rateKind: "cess",
    keywords: ["cess", "health and education"],
  },
  {
    key: "tds-section-rate",
    label: "TDS/TCS section rates",
    unit: "bps",
    description: "Per-section TDS/TCS deduction rates and monetary thresholds.",
    authority: "cbdt",
    cadence: "annual",
    rateKind: "tds-section",
    keywords: ["tds", "tcs", "deduction", "194", "206c", "withholding"],
  },
  {
    key: "gst-rate",
    label: "GST rate schedule",
    unit: "bps",
    description: "GST rate bands and the HSN/SAC schedule mapped to them.",
    authority: "cbic",
    cadence: "ad-hoc",
    rateKind: "gst-rate",
    keywords: ["gst", "rate", "hsn", "sac", "notification", "gst council"],
  },
  {
    key: "audit-turnover-limit-44ab",
    label: "Tax-audit turnover limit (s.44AB)",
    unit: "amount",
    description: "Turnover/receipts threshold above which a tax audit is required.",
    authority: "cbdt",
    cadence: "annual",
    keywords: ["44ab", "tax audit", "turnover limit", "threshold"],
  },
  {
    key: "presumptive-limit-44ad",
    label: "Presumptive scheme limit (s.44AD/44ADA)",
    unit: "amount",
    description: "Turnover / gross-receipts ceiling for the presumptive schemes.",
    authority: "cbdt",
    cadence: "annual",
    keywords: ["44ad", "44ada", "presumptive", "receipts limit"],
  },
  {
    key: "msme-43bh-window-days",
    label: "MSME 43B(h) payment window",
    unit: "days",
    description: "Maximum payment window to a registered MSME for s.43B(h) deduction.",
    authority: "mca",
    cadence: "ad-hoc",
    keywords: ["msme", "43b", "45 days", "payment window", "udyam"],
  },
  {
    key: "roc-aoc4-due-days",
    label: "ROC AOC-4 due window",
    unit: "days",
    description: "Days from the financial year end within which AOC-4 must be filed.",
    authority: "mca",
    cadence: "ad-hoc",
    keywords: ["aoc-4", "aoc4", "annual accounts", "roc", "mca", "due date"],
  },
  {
    key: "roc-mgt7-due-days",
    label: "ROC MGT-7 due window",
    unit: "days",
    description: "Days from the financial year end within which MGT-7 must be filed.",
    authority: "mca",
    cadence: "ad-hoc",
    keywords: ["mgt-7", "mgt7", "annual return", "roc", "mca", "due date"],
  },
  {
    key: "professional-tax-slab",
    label: "Professional tax slabs",
    unit: "paise",
    description: "State-wise professional tax slabs and monthly/annual caps.",
    authority: "state",
    cadence: "ad-hoc",
    keywords: ["professional tax", "pt", "state", "slab", "entry tax"],
  },
  {
    key: "epf-wage-ceiling",
    label: "EPF wage ceiling",
    unit: "amount",
    description: "Monthly wage ceiling for EPF/ESI statutory coverage.",
    authority: "epfo",
    cadence: "ad-hoc",
    keywords: ["epf", "pf", "esi", "wage ceiling", "ceiling"],
  },
  {
    key: "lrs-tcs-threshold",
    label: "LRS TCS threshold & rate",
    unit: "amount",
    description: "Liberalised Remittance Scheme threshold above which TCS applies.",
    authority: "cbdt",
    cadence: "annual",
    keywords: ["lrs", "remittance", "tcs", "liberalised remittance"],
  },
];

const CATALOG_BY_KEY = new Map(RULE_CATALOG.map((d) => [d.key, d]));

/** Look up a catalogue slot (throws for an unknown key — no silent fallback). */
export function ruleDefinition(key: string): RuleDefinition {
  const def = CATALOG_BY_KEY.get(key);
  if (!def) throw new StatutesError(`Unknown rule "${key}". Add it to RULE_CATALOG before registering versions.`);
  return def;
}

export function isKnownRuleKey(key: string): boolean {
  return CATALOG_BY_KEY.has(key);
}

// ---------------------------------------------------------------------------
// Dates — date-only strings everywhere so comparisons are TZ-independent
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoFromParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  // Reject impossible calendar days (e.g. 2026-02-31) by round-tripping.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day || parsed.getUTCMonth() + 1 !== month) return null;
  return iso;
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

/**
 * Extract the effective dates *stated in the text* of a notification. This is a
 * best-effort proposal generator — every date it returns is surfaced to a
 * reviewer for confirmation, never auto-applied.
 *
 * Recognised forms:
 *   "with effect from 1 April 2026" / "w.e.f. 01.04.2026" / "from 2026-04-01"
 *   "effective from April 1, 2026" / "up to 31 March 2026" (window end)
 */
export function extractEffectiveDates(text: string): { effectiveFrom: string | null; effectiveTo: string | null } {
  const source = text.replace(/\s+/g, " ");
  let effectiveFrom: string | null = null;
  let effectiveTo: string | null = null;

  // yyyy-mm-dd
  const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(source);
  if (isoMatch?.[1]) effectiveFrom = isoMatch[1];

  // dd.mm.yyyy or dd/mm/yyyy
  if (!effectiveFrom) {
    const dmy = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/.exec(source);
    if (dmy) effectiveFrom = isoFromParts(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  }

  // "1 April 2026" / "April 1, 2026"
  if (!effectiveFrom) {
    const dMonY = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(source);
    const monNum = dMonY?.[2] ? MONTHS[dMonY[2].toLowerCase()] : undefined;
    if (dMonY && monNum) effectiveFrom = isoFromParts(Number(dMonY[3]), monNum, Number(dMonY[1]));
  }
  if (!effectiveFrom) {
    const monDY = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(source);
    const monNum = monDY?.[1] ? MONTHS[monDY[1].toLowerCase()] : undefined;
    if (monDY && monNum) effectiveFrom = isoFromParts(Number(monDY[3]), monNum, Number(monDY[2]));
  }

  // Explicit end of window: "up to 31 March 2026" / "valid till 2026-06-30".
  const toMatch =
    /\b(?:up to|upto|until|till|valid till|valid up to)\s+(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/i.exec(source) ??
    /\b(?:up to|upto|until|till|valid till|valid up to)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(source);
  if (toMatch) {
    if (toMatch[1] && ISO_DATE.test(toMatch[1])) {
      effectiveTo = toMatch[1];
    } else if (toMatch[1] && toMatch[2] && toMatch[3]) {
      const monNum = MONTHS[toMatch[2].toLowerCase()];
      if (monNum) effectiveTo = isoFromParts(Number(toMatch[3]), monNum, Number(toMatch[1]));
    }
  }

  return { effectiveFrom, effectiveTo };
}

// ---------------------------------------------------------------------------
// Notification normalisation
// ---------------------------------------------------------------------------

export interface RawNotification {
  /** Stable key of the ingestion source this came from. */
  sourceKey: string;
  title: string;
  url: string;
  /** Authority's own identifier (e.g. "Notification No. 12/2026"). */
  externalId?: string | null;
  publishedAt?: string | null;
  bodyText?: string | null;
  authority?: NotificationAuthority | null;
}

export interface ParsedNotification {
  sourceKey: string;
  externalId: string | null;
  title: string;
  url: string;
  authority: NotificationAuthority;
  kind: NotificationKind;
  publishedAt: string | null;
  /** Dates proposed from the text — reviewer must confirm. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** Catalogue slots whose keywords appear in the text. */
  impactedRuleKeys: string[];
  /** SHA-256 over the normalised content (dedupe + change detection). */
  contentHash: string;
  /** Short excerpt kept for the review surface. */
  excerpt: string;
  /** Always true: this module proposes, a human publishes. */
  reviewRequired: true;
  warnings: string[];
}

const AUTHORITY_BY_HOST: [RegExp, NotificationAuthority][] = [
  [/incometax\.gov\.in|cbdt\.gov\.in/i, "cbdt"],
  [/cbic\.gov\.in|gst\.gov\.in/i, "cbic"],
  [/mca\.gov\.in/i, "mca"],
  [/rbi\.org\.in/i, "rbi"],
  [/epfindia\.gov\.in/i, "epfo"],
  [/gstcouncil\.gov\.in/i, "gst-council"],
];

/** Infer the publishing authority from an explicit value, URL host or text. */
export function inferAuthority(raw: RawNotification): NotificationAuthority {
  if (raw.authority) return raw.authority;
  const host = raw.url || "";
  for (const [pattern, authority] of AUTHORITY_BY_HOST) {
    if (pattern.test(host)) return authority;
  }
  const haystack = `${raw.sourceKey} ${raw.title}`.toLowerCase();
  if (/cbdt|income.?tax/.test(haystack)) return "cbdt";
  if (/cbic|customs|gst\b/.test(haystack)) return "cbic";
  if (/\bmca\b|companies act|company law|\broc\b/.test(haystack)) return "mca";
  if (/\brbi\b|fema/.test(haystack)) return "rbi";
  if (/\bepfo\b|\bepf\b/.test(haystack)) return "epfo";
  if (/gst council/.test(haystack)) return "gst-council";
  if (/state|professional tax/.test(haystack)) return "state";
  return "other";
}

/** Classify the item kind from its title. */
export function inferNotificationKind(title: string): NotificationKind {
  const t = title.toLowerCase();
  if (/\bcircular\b/.test(t)) return "circular";
  if (/press release/.test(t)) return "press-release";
  if (/\bamendment\b/.test(t)) return "amendment";
  if (/\border\b/.test(t)) return "order";
  return "notification";
}

/** Catalogue slots whose keywords appear in the notification text. */
export function impactedRuleKeys(text: string): string[] {
  const haystack = text.toLowerCase();
  const hits: string[] = [];
  for (const def of RULE_CATALOG) {
    const label = def.label.toLowerCase();
    if (def.keywords.some((k) => haystack.includes(k.toLowerCase())) || haystack.includes(label)) {
      hits.push(def.key);
    }
  }
  return hits;
}

/** Stable canonical JSON (sorted keys) so the content hash is order-insensitive. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Normalise a raw feed item into the canonical notification shape. Deterministic:
 * the same input always yields the same `contentHash`, so re-ingesting the same
 * item is a no-op and an edited item is detectable.
 */
export function normalizeNotification(raw: RawNotification): ParsedNotification {
  const title = (raw.title ?? "").trim().replace(/\s+/g, " ");
  const url = (raw.url ?? "").trim();
  if (!title) throw new StatutesError("A notification needs a title.");
  if (url && !/^https?:\/\//i.test(url)) throw new StatutesError(`Notification URL must be http(s): ${url}`);

  const authority = inferAuthority(raw);
  const kind = inferNotificationKind(title);
  const body = (raw.bodyText ?? "").trim();
  const combined = `${title}. ${body}`;
  const { effectiveFrom, effectiveTo } = extractEffectiveDates(combined);
  const impacted = impactedRuleKeys(combined);

  const contentHash = sha256Hex(
    canonicalJson({
      sourceKey: raw.sourceKey,
      externalId: raw.externalId ?? null,
      title,
      url,
      authority,
      kind,
      publishedAt: raw.publishedAt ?? null,
      effectiveFrom,
      effectiveTo,
      body,
    }),
  );

  const warnings: string[] = [];
  if (!effectiveFrom) warnings.push("No effective date found in the text — set it manually before publishing.");
  if (impacted.length === 0) warnings.push("No catalogue slot matched — decide manually which rule this changes.");

  return {
    sourceKey: raw.sourceKey,
    externalId: raw.externalId ?? null,
    title,
    url,
    authority,
    kind,
    publishedAt: raw.publishedAt ?? null,
    effectiveFrom,
    effectiveTo,
    impactedRuleKeys: impacted,
    contentHash,
    excerpt: body.slice(0, 600),
    reviewRequired: true,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Rule versioning
// ---------------------------------------------------------------------------

/** Canonical hash of a rule version's content (ignores ids/timestamps/status). */
export function hashRuleVersion(version: {
  ruleKey: string;
  applicability: Applicability;
  unit: RuleUnit;
  rows: RuleRow[];
  citation: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  valueSummary: string;
}): string {
  return sha256Hex(
    canonicalJson({
      ruleKey: version.ruleKey,
      applicability: version.applicability,
      unit: version.unit,
      rows: version.rows,
      citation: version.citation,
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      valueSummary: version.valueSummary,
    }),
  );
}

export interface RuleVersionInput {
  ruleKey: string;
  applicability: Applicability;
  unit: RuleUnit;
  rows: RuleRow[];
  valueSummary: string;
  citation: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notificationId?: string | null;
}

/** Validate a rule-version draft. Throws `StatutesError` with a fixable message. */
export function validateRuleVersionInput(input: RuleVersionInput): void {
  if (!isKnownRuleKey(input.ruleKey)) {
    throw new StatutesError(`Unknown rule "${input.ruleKey}". How to fix: choose a slot from the rule catalogue.`);
  }
  if (!isIsoDate(input.effectiveFrom)) {
    throw new StatutesError(`"effectiveFrom" must be yyyy-mm-dd (got ${input.effectiveFrom}).`);
  }
  if (input.effectiveTo != null) {
    if (!isIsoDate(input.effectiveTo))
      throw new StatutesError(`"effectiveTo" must be yyyy-mm-dd (got ${input.effectiveTo}).`);
    if (input.effectiveTo <= input.effectiveFrom) {
      throw new StatutesError("The effective window is empty: effectiveTo must be after effectiveFrom.");
    }
  }
  if (!input.valueSummary.trim()) throw new StatutesError("Add a plain-language value summary for the reviewer.");
  if (!input.citation.trim()) throw new StatutesError("Add the statutory citation this version relies on.");
  if (input.applicability.ay !== null && !/^\d{4}-\d{2}$/.test(input.applicability.ay)) {
    throw new StatutesError('Applicability AY must be null or "2026-27".');
  }
  if (input.applicability.scope === "state" && input.applicability.states.length === 0) {
    throw new StatutesError("A state-scoped rule needs at least one state code.");
  }
  if (input.rows.length === 0) throw new StatutesError("A rule version needs at least one row.");
  let sawOpenEnded = false;
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    if (sawOpenEnded) {
      throw new StatutesError("Only the LAST row may be open-ended (upTo = null).");
    }
    if (row.upTo === null) sawOpenEnded = true;
    if (row.upTo !== null && !Number.isFinite(row.upTo)) throw new StatutesError("Row bounds must be finite numbers.");
    if (!Number.isFinite(row.rate)) throw new StatutesError("Row rates must be finite numbers.");
    const prev = input.rows[i - 1];
    if (prev && prev.upTo !== null && row.upTo !== null && row.upTo <= prev.upTo) {
      throw new StatutesError("Row bounds must strictly increase (ascending slab order).");
    }
  }
  if (input.unit === "text") {
    throw new StatutesError("Text rules are not supported by the numeric registry — use a numeric unit.");
  }
}

/** Does a version's applicability cover the query context? */
export function applicabilityMatches(
  applicability: Applicability,
  query: { ay?: string | null; entityType?: string | null; state?: string | null },
): boolean {
  if (applicability.ay !== null && query.ay != null && applicability.ay !== query.ay) return false;
  if (applicability.ay !== null && query.ay == null) return false; // AY-scoped rule with no AY asked for
  if (applicability.entityTypes.length > 0) {
    if (!query.entityType || !applicability.entityTypes.includes(query.entityType)) return false;
  }
  if (applicability.states.length > 0) {
    if (!query.state || !applicability.states.includes(query.state)) return false;
  }
  return true;
}

/**
 * Specificity rank for tie-breaking: state-specific beats all-India, and each
 * named entity type beats "any". Higher is more specific.
 */
export function compareApplicabilitySpecificity(a: Applicability, b: Applicability): number {
  const score = (x: Applicability) => (x.states.length > 0 ? 100 : 0) + x.entityTypes.length + (x.ay !== null ? 1 : 0);
  return score(a) - score(b);
}

export interface ResolutionQuery {
  ruleKey: string;
  asOn: string;
  ay?: string | null;
  entityType?: string | null;
  state?: string | null;
}

export interface Resolution {
  version: RuleVersionRecord;
  /** Why this version won (surfaced for the audit trail / UI). */
  reason: string;
  /** Other published versions that matched, in precedence order. */
  alternatives: RuleVersionRecord[];
}

function inEffect(version: RuleVersionRecord, asOn: string): boolean {
  if (version.effectiveFrom > asOn) return false;
  if (version.effectiveTo !== null && asOn >= version.effectiveTo) return false;
  return true;
}

/**
 * Resolve the rule version in force for a query. Returns null when nothing is
 * in force — the caller must show "no rule in force" rather than guess.
 *
 * Precedence (documented, deterministic):
 *   1. published versions of this rule key
 *   2. applicability covers the query
 *   3. effective window contains `asOn`
 *   4. most specific applicability, then newest effectiveFrom, then highest version
 */
export function resolveRuleVersion(versions: readonly RuleVersionRecord[], query: ResolutionQuery): Resolution | null {
  if (!isIsoDate(query.asOn)) throw new StatutesError(`asOn must be yyyy-mm-dd (got ${query.asOn}).`);

  const candidates = versions
    .filter((v) => v.ruleKey === query.ruleKey)
    .filter((v) => v.status === "published")
    .filter((v) => applicabilityMatches(v.applicability, query))
    .filter((v) => inEffect(v, query.asOn));

  if (candidates.length === 0) return null;

  const ranked = [...candidates].sort((a, b) => {
    const specificity = compareApplicabilitySpecificity(b.applicability, a.applicability);
    if (specificity !== 0) return specificity;
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
    return b.version - a.version;
  });

  const winner = ranked[0]!;
  const scopeBits = [
    winner.applicability.states.length > 0 ? `state ${winner.applicability.states.join("/")}` : "all-India",
    winner.applicability.entityTypes.length > 0
      ? `entity ${winner.applicability.entityTypes.join("/")}`
      : "all entities",
    winner.applicability.ay ? `AY ${winner.applicability.ay}` : "any AY",
  ];
  return {
    version: winner,
    reason: `v${winner.version} in force from ${winner.effectiveFrom}${winner.effectiveTo ? ` to ${winner.effectiveTo}` : ""} (${scopeBits.join(", ")})`,
    alternatives: ranked.slice(1),
  };
}

/** Every published version of a rule, newest first (for the audit surface). */
export function ruleVersionsForRule(versions: readonly RuleVersionRecord[], ruleKey: string): RuleVersionRecord[] {
  return versions
    .filter((v) => v.ruleKey === ruleKey)
    .sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom ? b.version - a.version : a.effectiveFrom < b.effectiveFrom ? 1 : -1,
    );
}

/** All published versions in force at `asOn`, one per rule (the "as-on" view). */
export function rulesInForce(
  versions: readonly RuleVersionRecord[],
  asOn: string,
  query: { ay?: string | null; entityType?: string | null; state?: string | null } = {},
): RuleVersionRecord[] {
  const keys = new Set(versions.map((v) => v.ruleKey));
  const out: RuleVersionRecord[] = [];
  for (const key of keys) {
    const resolution = resolveRuleVersion(versions, { ruleKey: key, asOn, ...query });
    if (resolution) out.push(resolution.version);
  }
  return out.sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : 1));
}

export interface RuleDiff {
  ruleKey: string;
  from: { version: number; effectiveFrom: string; valueSummary: string } | null;
  to: { version: number; effectiveFrom: string; valueSummary: string } | null;
  rowsAdded: RuleRow[];
  rowsRemoved: RuleRow[];
  rowsChanged: { before: RuleRow; after: RuleRow }[];
  valueChanged: boolean;
}

/** Compare two rule versions (null side = introduced / withdrawn). */
export function diffRuleVersions(previous: RuleVersionRecord | null, next: RuleVersionRecord | null): RuleDiff {
  const ruleKey = next?.ruleKey ?? previous?.ruleKey;
  if (!ruleKey) throw new StatutesError("Cannot diff two empty versions.");
  const before = previous?.rows ?? [];
  const after = next?.rows ?? [];
  const len = Math.max(before.length, after.length);
  const rowsAdded: RuleRow[] = [];
  const rowsRemoved: RuleRow[] = [];
  const rowsChanged: { before: RuleRow; after: RuleRow }[] = [];
  for (let i = 0; i < len; i++) {
    const b = before[i];
    const a = after[i];
    if (!b && a) rowsAdded.push(a);
    else if (b && !a) rowsRemoved.push(b);
    else if (b && a && (b.upTo !== a.upTo || b.rate !== a.rate)) rowsChanged.push({ before: b, after: a });
  }
  return {
    ruleKey,
    from: previous
      ? { version: previous.version, effectiveFrom: previous.effectiveFrom, valueSummary: previous.valueSummary }
      : null,
    to: next ? { version: next.version, effectiveFrom: next.effectiveFrom, valueSummary: next.valueSummary } : null,
    rowsAdded,
    rowsRemoved,
    rowsChanged,
    valueChanged:
      previous?.valueSummary !== next?.valueSummary ||
      rowsChanged.length > 0 ||
      rowsAdded.length > 0 ||
      rowsRemoved.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Bridge to the compute engines (lib/engine/ca-rate-registry)
// ---------------------------------------------------------------------------

/** Convert a published rule version into the RateTable the engines consume. */
export function toRateTable(version: RuleVersionRecord): RateTable {
  const def = ruleDefinition(version.ruleKey);
  if (!def.rateKind) {
    throw new StatutesError(`Rule "${version.ruleKey}" is not a rate table and cannot feed the compute engines.`);
  }
  if (version.unit !== "paise" && version.unit !== "bps" && version.unit !== "amount") {
    throw new StatutesError(`Rule "${version.ruleKey}" has unit "${version.unit}" which is not a rate-table unit.`);
  }
  const rows: SlabRow[] = version.rows.map((r) => ({ upTo: r.upTo, rate: r.rate }));
  return {
    ay: version.applicability.ay ?? "any",
    kind: def.rateKind,
    unit: version.unit,
    source: `${version.citation} (${version.valueSummary})`,
    asOn: version.effectiveFrom,
    rows,
  };
}

/**
 * Every rate table a set of published versions can hand to the engines, keyed
 * by the ca-rate-registry kind. Rules that are not rate tables are skipped.
 */
export function rateTablesFromVersions(
  versions: readonly RuleVersionRecord[],
): { kind: RateKind; table: RateTable; ruleKey: string }[] {
  const out: { kind: RateKind; table: RateTable; ruleKey: string }[] = [];
  for (const version of versions) {
    const def = CATALOG_BY_KEY.get(version.ruleKey);
    if (!def?.rateKind) continue;
    if (version.unit !== "paise" && version.unit !== "bps" && version.unit !== "amount") continue;
    out.push({ kind: def.rateKind, table: toRateTable(version), ruleKey: version.ruleKey });
  }
  return out;
}
