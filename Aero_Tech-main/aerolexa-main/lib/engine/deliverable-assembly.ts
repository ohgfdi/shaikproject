/**
 * Deliverable assembly engine — builds a version's content from a template,
 * resolved placeholders, optional computed results, redaction rules, and
 * working-paper trace links.
 *
 * This is the heart of the firm-grade deliverable layer: it turns a template
 * (engagement-level or derived from an org master) into a signed deliverable
 * with a CLIENT variant (redacted identifiers) and a REVIEWER variant (full
 * identifiers), each with an immutable content hash and working-paper
 * traceability.
 */

import type {
  EngagementReportTemplate,
  EngagementReportFormat,
  EngagementDeliverablePart,
  EngagementDeliverableRedaction,
  WorkingPaper,
  WorkingPaperVersion,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { redactSensitiveValue, scrubIdentifiersInText, stableToken } from "@/lib/server/engagement";

import {
  certificate44ABWording,
  certificate44ADAWording,
  certificate44ADWording,
  advanceTaxComputationWording,
  MGMT_LETTER_SKELETON,
  NOTES_SKELETON_TITLES,
  defaultClausesForFormat,
  CLAUSE_LABELS,
} from "./deliverable-coefficients";

export type { EngagementReportTemplate } from "@/generated/prisma/client";
export type { EngagementDeliverablePart } from "@/generated/prisma/client";
export type { EngagementDeliverableRedaction } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\^\^([A-Z_]+)\^\^/g;

export const PLACEHOLDER_KEYS = [
  "FIRM_NAME",
  "FIRM_ADDRESS",
  "SIGNATORY_NAME",
  "SIGNATORY_DESIGNATION",
  "DATE_LABEL",
  "CLIENT_NAME",
  "ENGAGEMENT_NAME",
  "PERIOD_ENDING",
  "REPORT_DATE",
  "ASSESSMENT_YEAR",
  "GSTIN",
  "PAN",
  "CIN",
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];

export interface PlaceholderValues {
  FIRM_NAME?: string;
  FIRM_ADDRESS?: string;
  SIGNATORY_NAME?: string;
  SIGNATORY_DESIGNATION?: string;
  DATE_LABEL?: string;
  CLIENT_NAME?: string;
  ENGAGEMENT_NAME?: string;
  PERIOD_ENDING?: string;
  REPORT_DATE?: string;
  ASSESSMENT_YEAR?: string;
  GSTIN?: string;
  PAN?: string;
  CIN?: string;
}

export function resolvePlaceholders(
  text: string,
  values: PlaceholderValues,
  redactIdentifiers: boolean,
  _identifierContext?: string,
): string {
  let out = text;

  for (const key of PLACEHOLDER_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    const token = `^^${key}^^`;
    if (out.includes(token)) {
      const resolved =
        redactIdentifiers && isSensitiveKey(key)
          ? redactSensitiveValue(sensitiveCategoryFor(key), value, false)
          : value;
      out = out.replaceAll(token, resolved);
    }
  }

  if (redactIdentifiers) {
    out = out.replace(PLACEHOLDER_RE, "[redacted — not provided for client copy]");
    out = scrubIdentifiersInText(out);
  }

  return out;
}

function isSensitiveKey(key: string): boolean {
  return key === "GSTIN" || key === "PAN" || key === "CIN" || key === "DIN" || key === "TAN";
}

function sensitiveCategoryFor(key: string): "gstin" | "pan" | "cin" | "din" | "tan" {
  switch (key) {
    case "GSTIN":
      return "gstin";
    case "PAN":
      return "pan";
    case "CIN":
      return "cin";
    case "DIN":
      return "din";
    case "TAN":
      return "tan";
    default:
      return "pan";
  }
}

// ---------------------------------------------------------------------------
// Template body parsing + rendering
// ---------------------------------------------------------------------------

export interface TemplatePart {
  kind: "cover" | "preamble" | "body" | "schedule" | "note" | "certificate" | "letter" | "appendix" | "clauses";
  heading: string;
  body: string;
  ref?: string;
}

export interface EngagementReportTemplateBody {
  parts: TemplatePart[];
  precedents: string[];
  cover: {
    title: string;
    subtitle?: string;
    docRef?: string;
  } | null;
}

function parseTemplateBody(raw: string): EngagementReportTemplateBody {
  return parseJson<EngagementReportTemplateBody>(raw, {
    parts: [],
    precedents: [],
    cover: null,
  });
}

export interface RenderedParts {
  parts: RenderedPart[];
  fullBodyMarkdown: string;
}

interface RenderedPart {
  kind: string;
  heading: string;
  body: string;
  ref?: string;
  order: number;
}

export interface RenderOptions {
  variant: "CLIENT" | "REVIEWER";
  placeholders: PlaceholderValues;
  redactions?: EngagementDeliverableRedaction[];
  extraBody?: string;
  precedents?: string[];
  /**
   * Keep `^^TOKEN^^` placeholders unresolved. Used when persisting a version:
   * the stored body must stay variant-neutral so the render endpoint can then
   * resolve it as CLIENT (masked identifiers) or REVIEWER (full) on demand.
   * Baking one variant in at assembly makes the other unrecoverable.
   */
  preservePlaceholders?: boolean;
}

export function renderTemplate(bodyRaw: string, opts: RenderOptions): RenderedParts {
  const parsed = parseTemplateBody(bodyRaw);
  const rendered: RenderedPart[] = [];
  let fullBody = "";
  let order = 0;

  const resolve = (text: string, context?: string): string =>
    opts.preservePlaceholders ? text : resolvePlaceholders(text, opts.placeholders, opts.variant === "CLIENT", context);

  if (parsed.cover) {
    const coverText = [
      `# ${resolve(parsed.cover.title, "title")}`,
      parsed.cover.subtitle ? `## ${resolve(parsed.cover.subtitle, "subtitle")}` : null,
      parsed.cover.docRef ? `**Ref: ${resolve(parsed.cover.docRef, "docRef")}**` : null,
    ]
      .filter(Boolean)
      .join("\n");
    rendered.push({ kind: "cover", heading: "Cover", body: coverText, order: order++ });
    fullBody += coverText + "\n\n";
  }

  for (const part of parsed.parts) {
    const resolvedBody = resolve(part.body, part.kind);
    rendered.push({ kind: part.kind, heading: part.heading, body: resolvedBody, ref: part.ref, order: order++ });
    fullBody += `**${part.heading}**\n\n${resolvedBody}\n\n---\n\n`;
  }

  const precedentTexts = (opts.precedents ?? []).map((p) => resolve(p, "precedent"));
  if (precedentTexts.length) {
    const precedentBody = precedentTexts.join("\n\n");
    rendered.push({ kind: "precedent", heading: "Precedent paragraphs", body: precedentBody, order: order++ });
    fullBody += `**Precedent paragraphs**\n\n${precedentBody}\n\n---\n\n`;
  }

  if (opts.extraBody) {
    const resolvedExtra = opts.preservePlaceholders
      ? opts.extraBody
      : resolvePlaceholders(opts.extraBody, opts.placeholders, opts.variant === "CLIENT", "extra");
    rendered.push({ kind: "extra", heading: "Computed schedules / results", body: resolvedExtra, order: order++ });
    fullBody += `**Computed schedules / results**\n\n${resolvedExtra}\n\n---\n\n`;
  }

  return { parts: rendered, fullBodyMarkdown: fullBody };
}

// ---------------------------------------------------------------------------
// Certificate builders
// ---------------------------------------------------------------------------

export function build44ABCertificateBody(
  opts: RenderOptions,
  params: {
    turnoverGross: string;
    turnoverExempt: string;
    cashReceipts: string;
    bookkeeping: string;
    auditPerformedBy: string;
    auditPerformedFrom: string;
    auditPerformedTo: string;
    notes: string[];
  },
): string {
  const firmName = opts.placeholders.FIRM_NAME ?? "[Firm Name]";
  const resolved = resolvePlaceholders(firmName, opts.placeholders, false);
  return certificate44ABWording({
    firmName: resolved,
    clientName: opts.placeholders.CLIENT_NAME ?? "[Client]",
    assessmentYear: opts.placeholders.ASSESSMENT_YEAR ?? "[AY]",
    periodEnding: opts.placeholders.PERIOD_ENDING ?? "[period]",
    turnoverGross: params.turnoverGross,
    turnoverExempt: params.turnoverExempt,
    cashReceipts: params.cashReceipts,
    bookkeeping: params.bookkeeping,
    auditPerformedBy: params.auditPerformedBy,
    auditPerformedFrom: params.auditPerformedFrom,
    auditPerformedTo: params.auditPerformedTo,
    notes: params.notes,
  });
}

export function build44ADACertificateBody(
  opts: RenderOptions,
  params: {
    grossReceiptsPerBooks: string;
    grossReceiptsPerReturn: string;
    bankingChannelPct: string;
    presumptiveIncomeDeclared: string;
    expensesClaimedOver80Pct: string;
    auditPerformedBy: string;
    auditPerformedFrom: string;
    auditPerformedTo: string;
    notes: string[];
  },
): string {
  const firmName = resolvePlaceholders(opts.placeholders.FIRM_NAME ?? "[Firm]", opts.placeholders, false);
  return certificate44ADAWording({
    firmName,
    clientName: opts.placeholders.CLIENT_NAME ?? "[Client]",
    assessmentYear: opts.placeholders.ASSESSMENT_YEAR ?? "[AY]",
    periodEnding: opts.placeholders.PERIOD_ENDING ?? "[period]",
    grossReceiptsPerBooks: params.grossReceiptsPerBooks,
    grossReceiptsPerReturn: params.grossReceiptsPerReturn,
    bankingChannelPct: params.bankingChannelPct,
    presumptiveIncomeDeclared: params.presumptiveIncomeDeclared,
    expensesClaimedOver80Pct: params.expensesClaimedOver80Pct,
    auditPerformedBy: params.auditPerformedBy,
    auditPerformedFrom: params.auditPerformedFrom,
    auditPerformedTo: params.auditPerformedTo,
    notes: params.notes,
  });
}

export function build44ADCertificateBody(
  opts: RenderOptions,
  params: {
    turnoverGross: string;
    cashReceipts: string;
    bankingChannelPct: string;
    presumptiveIncomeDeclared: string;
    auditPerformedBy: string;
    auditPerformedFrom: string;
    auditPerformedTo: string;
    notes: string[];
  },
): string {
  const firmName = resolvePlaceholders(opts.placeholders.FIRM_NAME ?? "[Firm]", opts.placeholders, false);
  return certificate44ADWording({
    firmName,
    clientName: opts.placeholders.CLIENT_NAME ?? "[Client]",
    assessmentYear: opts.placeholders.ASSESSMENT_YEAR ?? "[AY]",
    periodEnding: opts.placeholders.PERIOD_ENDING ?? "[period]",
    turnoverGross: params.turnoverGross,
    cashReceipts: params.cashReceipts,
    bankingChannelPct: params.bankingChannelPct,
    presumptiveIncomeDeclared: params.presumptiveIncomeDeclared,
    auditPerformedBy: params.auditPerformedBy,
    auditPerformedFrom: params.auditPerformedFrom,
    auditPerformedTo: params.auditPerformedTo,
    notes: params.notes,
  });
}

export function buildAdvanceTaxCertificateBody(
  opts: RenderOptions,
  params: {
    totalIncomeComputed: string;
    taxLiabilityTotal: string;
    tdsTcsCredit: string;
    advanceTaxPaid: string;
    selfAssessmentTaxPayable: string;
    instalmentDueDates: { dueDate: string; payable: string }[];
  },
): string {
  return advanceTaxComputationWording({
    firmName: opts.placeholders.FIRM_NAME ?? "[Firm]",
    clientName: opts.placeholders.CLIENT_NAME ?? "[Client]",
    assessmentYear: opts.placeholders.ASSESSMENT_YEAR ?? "[AY]",
    periodEnding: opts.placeholders.PERIOD_ENDING ?? "[period]",
    totalIncomeComputed: params.totalIncomeComputed,
    taxLiabilityTotal: params.taxLiabilityTotal,
    tdsTcsCredit: params.tdsTcsCredit,
    advanceTaxPaid: params.advanceTaxPaid,
    selfAssessmentTaxPayable: params.selfAssessmentTaxPayable,
    instalmentDueDates: params.instalmentDueDates,
    signingCa: opts.placeholders.SIGNATORY_NAME ?? "[Signatory]",
  });
}

// ---------------------------------------------------------------------------
// Management letter builder
// ---------------------------------------------------------------------------

export function buildMgmtLetterBody(
  opts: RenderOptions,
  params: {
    findings: string[];
    suggestions: string[];
  },
): string {
  const pv: PlaceholderValues = {
    CLIENT_NAME: opts.placeholders.CLIENT_NAME,
    ENGAGEMENT_NAME: opts.placeholders.ENGAGEMENT_NAME,
    PERIOD_ENDING: opts.placeholders.PERIOD_ENDING,
  };

  let body = "";
  for (const section of MGMT_LETTER_SKELETON) {
    let sectionBody = resolvePlaceholders(section.body, pv, opts.variant === "CLIENT", section.heading);
    if (section.heading === "Summary of observations") {
      sectionBody = sectionBody.replace("{observations}", params.findings.join("\n\n"));
    }
    if (section.heading === "Suggestions for improvement") {
      sectionBody = sectionBody.replace("{suggestions}", params.suggestions.join("\n\n"));
    }
    body += `**${section.heading}**\n\n${sectionBody}\n\n---\n\n`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Certificate dispatcher
// ---------------------------------------------------------------------------

/** A fully-built certificate/letter part ready to be persisted and rendered. */
export interface CertificatePart {
  heading: string;
  body: string;
}

/**
 * Discriminated request describing which structured certificate to generate and
 * the figures it needs. The route accepts this on assembly; the engine owns the
 * mapping from a format to its wording builder so the builders are never
 * orphaned.
 */
export type CertificateRequest =
  | {
      format: "CERTIFICATE_44AB";
      params: Parameters<typeof build44ABCertificateBody>[1];
    }
  | {
      format: "CERTIFICATE_44ADA";
      params: Parameters<typeof build44ADACertificateBody>[1];
    }
  | {
      format: "CERTIFICATE_44AD";
      params: Parameters<typeof build44ADCertificateBody>[1];
    }
  | {
      format: "ADVANCE_TAX";
      params: Parameters<typeof buildAdvanceTaxCertificateBody>[1];
    }
  | {
      format: "MGMT_LETTER";
      params: Parameters<typeof buildMgmtLetterBody>[1];
    };

const CERTIFICATE_HEADINGS: Record<CertificateRequest["format"], string> = {
  CERTIFICATE_44AB: "Tax audit certificate (section 44AB)",
  CERTIFICATE_44ADA: "Presumptive taxation certificate (section 44ADA)",
  CERTIFICATE_44AD: "Presumptive taxation certificate (section 44AD)",
  ADVANCE_TAX: "Advance tax computation certificate",
  MGMT_LETTER: "Management letter",
};

/**
 * Build the body for a requested certificate/letter using the matching wording
 * builder. Returns `null` when no request is supplied so callers can fall back
 * to the template-rendered part.
 */
export function buildCertificatePartBody(
  request: CertificateRequest | null | undefined,
  opts: RenderOptions,
): CertificatePart | null {
  if (!request) return null;

  switch (request.format) {
    case "CERTIFICATE_44AB":
      return { heading: CERTIFICATE_HEADINGS.CERTIFICATE_44AB, body: build44ABCertificateBody(opts, request.params) };
    case "CERTIFICATE_44ADA":
      return { heading: CERTIFICATE_HEADINGS.CERTIFICATE_44ADA, body: build44ADACertificateBody(opts, request.params) };
    case "CERTIFICATE_44AD":
      return { heading: CERTIFICATE_HEADINGS.CERTIFICATE_44AD, body: build44ADCertificateBody(opts, request.params) };
    case "ADVANCE_TAX":
      return { heading: CERTIFICATE_HEADINGS.ADVANCE_TAX, body: buildAdvanceTaxCertificateBody(opts, request.params) };
    case "MGMT_LETTER":
      return { heading: CERTIFICATE_HEADINGS.MGMT_LETTER, body: buildMgmtLetterBody(opts, request.params) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Clause list rendering
// ---------------------------------------------------------------------------

export function renderClauseList(formatClauses?: string, extraClauses?: string[]): string {
  const declared = parseJson<Record<string, string>>(formatClauses, {});
  const refs = new Set<string>([...Object.keys(declared), ...(extraClauses ?? [])]);
  const lines = [...refs].map((ref) => {
    const label = declared[ref] ?? CLAUSE_LABELS[ref as keyof typeof CLAUSE_LABELS] ?? ref;
    return `- **${ref}** — ${label}`;
  });
  return `# Reporting framework and statutory references\n\nThe deliverable has been prepared with reference to the following:\n\n${lines.join("\n")}`;
}
// Notes-to-accounts skeleton
// ---------------------------------------------------------------------------

export function renderNotesSkeleton(notes?: string): string {
  const existing = parseJson<string[]>(notes, []);
  const titles = NOTES_SKELETON_TITLES;
  const lines = titles.map((t) => {
    const status = existing.includes(t) ? "✓ (filled in template)" : "(to be prepared)";
    return `- ${t} ${status}`;
  });
  return `# Notes to the financial statements — skeleton\n\nThe following notes are standard for a full set of financial statements. Those marked as filled are addressed in the engagement template; the remainder are pending preparation.\n\n${lines.join("\n")}`;
}
// Working-paper trace
// ---------------------------------------------------------------------------

export interface WorkingPaperTraceInput {
  engagementId: string;
  indexRefs?: string[];
  maxVersionsPerPaper?: number;
}

export interface WorkingPaperTracePart {
  wp: WorkingPaper;
  latestVersion: WorkingPaperVersion | null;
  priorVersions: WorkingPaperVersion[];
}

export async function loadWorkingPapersForTrace(
  engagementId: string,
  indexRefs?: string[],
  maxVersionsPerPaper = 3,
): Promise<WorkingPaperTracePart[]> {
  const where = indexRefs?.length ? { engagementId, indexRef: { in: indexRefs } } : { engagementId };

  const papers = await prisma.workingPaper.findMany({
    where,
    orderBy: { indexRef: "asc" },
    take: 200,
  });

  const out: WorkingPaperTracePart[] = [];
  for (const paper of papers) {
    const versions = await prisma.workingPaperVersion.findMany({
      where: { workingPaperId: paper.id },
      orderBy: { version: "desc" },
      take: maxVersionsPerPaper,
    });
    const latest = versions[0] ?? null;
    const prior = versions.slice(1);
    out.push({ wp: paper, latestVersion: latest, priorVersions: prior });
  }
  return out;
}

export function renderWorkingPaperTracePart(
  trace: WorkingPaperTracePart,
  variant: "CLIENT" | "REVIEWER",
  placeholders: PlaceholderValues,
): string {
  const showFull = variant === "REVIEWER";
  const wp = trace.wp;

  const lines = [
    `**Working paper: ${resolvePlaceholders(wp.title, placeholders, false)}**`,
    `Index ref: ${wp.indexRef}`,
    `Section: ${wp.section ?? "(not specified)"}`,
    `SA reference: ${wp.saReference ?? "(not specified)"}`,
    `Status: ${wp.status}`,
    `Classification: ${wp.classification}`,
    `Prepared by: ${showFull && trace.latestVersion ? "Member #" + trace.latestVersion.preparedById.slice(0, 8) + "..." : "(redacted for client copy)"}`,
    `Prepared at: ${trace.latestVersion ? trace.latestVersion.createdAt.toISOString() : "(not available)"}`,
    "",
  ];

  if (trace.latestVersion) {
    const content = parseJson<Record<string, unknown>>(trace.latestVersion.content, {});
    const summary = content?.changeSummary ?? content?.summary ?? "(no change summary recorded)";
    const redactedSummary = showFull
      ? scrubIdentifiersInText(typeof summary === "string" ? summary : String(summary))
      : `(${stableToken(String(summary))})`;
    lines.push(`**Latest revision summary:** ${redactedSummary}`);
  }

  if (trace.priorVersions.length) {
    lines.push("", `**Prior revisions (${trace.priorVersions.length}):**`);
    for (const v of trace.priorVersions) {
      const s = showFull
        ? (parseJson<Record<string, unknown>>(v.content, {})?.changeSummary ?? "")
        : stableToken(v.content);
      lines.push(`- Rev ${v.version} — ${v.createdAt.toISOString()} — ${s}`);
    }
  }

  return lines.join("\n");
}

export function renderTraceabilityStatement(
  traceParts: WorkingPaperTracePart[],
  variant: "CLIENT" | "REVIEWER",
): string {
  const count = traceParts.length;
  const showFull = variant === "REVIEWER";
  const refs = traceParts.map((t) => t.wp.indexRef).join(", ");
  const note = showFull
    ? "The full working-paper register, including preparer identity and revision history, is available in the engagement file. The client copy carries redacted working-paper identifiers as required."
    : "The reviewer copy of this deliverable carries the full working-paper register; the client copy carries redacted references only.";
  return `**Working-paper traceability**\n\nThis deliverable is supported by ${count} working paper(s) with the following index references: ${refs}. ${note}\n\n`;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export function hashContent(body: string): string {
  let h = 0;
  for (let i = 0; i < body.length; i++) {
    h = (Math.imul(31, h) + body.charCodeAt(i)) | 0;
  }
  const hex = (Math.abs(h) >>> 0).toString(16).padStart(8, "0");
  return `d-${hex}`;
}

// ---------------------------------------------------------------------------
// Full assembly
// ---------------------------------------------------------------------------

export interface AssembleInput {
  template: EngagementReportTemplate;
  format?: EngagementReportFormat;
  computedBody?: string;
  workingPapers?: WorkingPaperTracePart[];
  renderOpts: RenderOptions;
  /** Structured certificate/letter to weave in (see buildCertificatePartBody). */
  certificate?: CertificatePart | null;
  /** Additional rendered parts (notes skeleton, computed schedules, etc.). */
  supplementaryParts?: SupplementaryPart[];
}

/** A scaffolded part woven into the assembled content (e.g. notes skeleton). */
export interface SupplementaryPart {
  heading: string;
  body: string;
  source?: string;
  sourceRef?: string | null;
}

export interface AssembleOutput {
  parts: Omit<EngagementDeliverablePart, "id" | "createdAt" | "organizationId" | "engagementId" | "versionId">[];
  contentHash: string;
  fullBodyMarkdown: string;
}

export async function assemble(input: AssembleInput): Promise<AssembleOutput> {
  const {
    template,
    format,
    computedBody,
    workingPapers = [],
    renderOpts,
    certificate,
    supplementaryParts = [],
  } = input;
  const variant = renderOpts.variant;

  const rendered = renderTemplate(template.body, renderOpts);

  const clauseList = renderClauseList(format?.clauses ?? undefined, defaultClausesForFormat(template.formatCode));
  const clausePart: Omit<
    EngagementDeliverablePart,
    "id" | "organizationId" | "engagementId" | "versionId" | "createdAt"
  > = {
    kind: "clauses",
    heading: "Reporting framework and statutory references",
    bodyMarkdown: clauseList,
    order: 0,
    ref: null,
    attachments: "[]",
    source: "template",
    sourceRef: null,
    createdById: null,
  };

  const parts: AssembleOutput["parts"] = [
    clausePart,
    ...rendered.parts.map((rp) => ({
      kind: rp.kind as EngagementDeliverablePart["kind"],
      heading: rp.heading,
      bodyMarkdown: rp.body,
      ref: rp.ref ?? null,
      order: rp.order,
      attachments: "[]",
      source: "template" as const,
      sourceRef: template.id,
      createdById: null,
    })),
  ];

  if (certificate) {
    const resolvedBody = renderOpts.preservePlaceholders
      ? certificate.body
      : resolvePlaceholders(certificate.body, renderOpts.placeholders, renderOpts.variant === "CLIENT", "certificate");
    parts.push({
      kind: "certificate",
      heading: certificate.heading,
      bodyMarkdown: resolvedBody,
      ref: null,
      order: parts.length,
      attachments: "[]",
      source: "computed",
      sourceRef: null,
      createdById: null,
    });
  }

  if (computedBody) {
    parts.push({
      kind: "schedule",
      heading: "Computed schedules / results",
      bodyMarkdown: computedBody,
      ref: null,
      order: parts.length,
      attachments: "[]",
      source: "computed",
      sourceRef: null,
      createdById: null,
    });
  }

  for (const extra of supplementaryParts) {
    const resolvedBody = renderOpts.preservePlaceholders
      ? extra.body
      : resolvePlaceholders(extra.body, renderOpts.placeholders, renderOpts.variant === "CLIENT", "appendix");
    parts.push({
      kind: "appendix",
      heading: extra.heading,
      bodyMarkdown: resolvedBody,
      ref: null,
      order: parts.length,
      attachments: "[]",
      source: extra.source ?? "manual",
      sourceRef: extra.sourceRef ?? null,
      createdById: null,
    });
  }

  for (const trace of workingPapers) {
    const wpBody = renderWorkingPaperTracePart(trace, variant, renderOpts.placeholders);
    parts.push({
      kind: "workingPaperTrace",
      heading: `Working paper: ${trace.wp.indexRef} — ${trace.wp.title}`,
      bodyMarkdown: wpBody,
      ref: trace.wp.indexRef,
      order: parts.length,
      attachments: "[]",
      source: "workingPaper",
      sourceRef: trace.wp.id,
      createdById: null,
    });
  }

  const fullBody = parts
    .sort((a, b) => a.order - b.order)
    .map((p) => `## ${p.heading}\n\n${p.bodyMarkdown}`)
    .join("\n\n---\n\n");

  const contentHash = hashContent(fullBody);

  return { parts, contentHash, fullBodyMarkdown: fullBody };
}
