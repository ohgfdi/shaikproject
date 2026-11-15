/**
 * One renderer for a deliverable version.
 *
 * The firm view (`/api/organization/engagements/:id/deliverables/:versionId/render`)
 * and the client portal must render the *same bytes* for the CLIENT variant:
 * placeholders resolved, identifiers scrubbed, redaction rules applied in the
 * same order. Keeping that pipeline in one function is the only way the portal
 * cannot drift into showing a client more than the firm previewed.
 */

import { prisma } from "@/lib/db";
import { PLACEHOLDER_KEYS, hashContent, resolvePlaceholders, type PlaceholderValues } from "@/lib/engine/deliverable-assembly";
import { parseJson } from "@/lib/json";
import { applyRedactions } from "@/lib/server/deliverables";
import { scrubIdentifiersInText } from "@/lib/server/engagement";

export type DeliverableVariant = "CLIENT" | "REVIEWER";

export interface RenderedPart {
  kind: string;
  heading: string;
  body: string;
  ref?: string | null;
  order: number;
  source: string | null;
  sourceRef: string | null;
}

export interface RenderedDeliverable {
  versionId: string;
  variant: DeliverableVariant;
  formatCode: string;
  formatLabel: string;
  revision: number;
  status: string;
  contentHash: string;
  assembledBody: string;
  parts: RenderedPart[];
  redactions: {
    policy: string;
    appliesTo: string;
    effectiveForVariant: string;
    note?: string | null;
  }[];
  traceability: { workingPaperRefs: string[] } | null;
}

/** Render one version, scoped to its engagement. Returns null when not found. */
export async function renderDeliverableVersion(input: {
  engagementId: string;
  versionId: string;
  variant: DeliverableVariant;
}): Promise<RenderedDeliverable | null> {
  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: input.versionId, engagementId: input.engagementId },
    include: {
      format: { select: { label: true } },
    },
  });
  if (!version) return null;

  const [rawParts, redactions] = await Promise.all([
    prisma.engagementDeliverablePart.findMany({
      where: { versionId: version.id },
      orderBy: { order: "asc" },
      take: 500,
    }),
    prisma.engagementDeliverableRedaction.findMany({
      where: { versionId: version.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const content = version.content ? parseJson<Record<string, unknown>>(version.content, {}) : {};
  const storedPlaceholders = (content.placeholders as Record<string, string> | undefined) ?? {};

  const placeholders: PlaceholderValues = {};
  for (const key of PLACEHOLDER_KEYS) {
    const value = storedPlaceholders[key];
    // Only resolve keys actually supplied at assembly time. Unknown tokens stay
    // as ^^KEY^^ (REVIEWER) or become a redaction notice (CLIENT) rather than
    // polluting the document with "[missing …]" markers.
    if (value !== undefined) placeholders[key as keyof PlaceholderValues] = value;
  }

  const variant = input.variant;
  const renderBody = (raw: string): string => {
    const resolved = resolvePlaceholders(raw, placeholders, variant === "CLIENT", "content");
    if (variant === "REVIEWER") return resolved;
    const scrubbed = scrubIdentifiersInText(resolved);
    return applyRedactions(
      scrubbed,
      redactions as Array<{ policy: string; appliesTo: string; effectiveForVariant: string }>,
      variant,
    );
  };

  const parts: RenderedPart[] = (
    rawParts as Array<{
      kind: string;
      heading: string;
      bodyMarkdown: string;
      ref?: string | null;
      order: number;
      source: string | null;
      sourceRef: string | null;
    }>
  ).map((p) => ({
    kind: p.kind,
    heading: p.heading,
    body: renderBody(p.bodyMarkdown),
    ref: p.ref,
    order: p.order,
    source: p.source,
    sourceRef: p.sourceRef,
  }));

  const orderedParts = [...parts].sort((a, b) => a.order - b.order);
  const assembledBody = orderedParts.map((p) => `## ${p.heading}\n\n${p.body}`).join("\n\n---\n\n");
  const recomputedHash = hashContent(assembledBody);
  const workingPaperRefs = [
    ...new Set(rawParts.filter((p) => p.source === "workingPaper" && p.ref).map((p) => p.ref as string)),
  ];

  return {
    versionId: version.id,
    variant,
    formatCode: version.formatCode,
    formatLabel: version.format?.label ?? version.formatCode,
    revision: version.revision,
    status: version.status,
    contentHash: version.bodyHash ?? recomputedHash,
    assembledBody,
    parts,
    redactions: (
      redactions as Array<{ policy: string; appliesTo: string; effectiveForVariant: string; note?: string | null }>
    ).map((r) => ({
      policy: r.policy,
      appliesTo: r.appliesTo,
      effectiveForVariant: r.effectiveForVariant,
      note: r.note,
    })),
    traceability: workingPaperRefs.length ? { workingPaperRefs } : null,
  };
}
