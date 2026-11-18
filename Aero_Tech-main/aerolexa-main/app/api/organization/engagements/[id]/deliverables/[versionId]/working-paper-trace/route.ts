import { z } from "zod";

import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  hashContent,
  loadWorkingPapersForTrace,
  renderWorkingPaperTracePart,
  type PlaceholderValues,
} from "@/lib/engine/deliverable-assembly";
import { parseJson, stringifyJson } from "@/lib/json";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { canPrepareWork, requireEngagementRole } from "@/lib/server/engagement";
import { appendLedgerEntry } from "@/lib/server/governance";

export const dynamic = "force-dynamic";

/**
 * Working-paper traceability for an assembled deliverable version.
 *
 * Assembly can already carry working papers in (`assemble` accepts
 * `workingPaperRefs`), but a preparer routinely finishes a document and only
 * then decides which binder papers evidence it. This endpoint attaches that
 * evidence to an existing version without re-assembling, so the audit trail
 * points at the same artifact review and sign-off act on.
 *
 * The rules that keep the trail honest:
 *
 *   - Only a DRAFT can gain traceability. Once the version is submitted,
 *     reviewed, signed off or issued, its content is the thing a partner put
 *     their name against — silently appending evidence afterwards would make
 *     the ledger lie. Assemble a new revision instead.
 *   - Every reference must exist in THIS engagement; unknown refs fail closed
 *     rather than recording a pointer to nothing.
 *   - Repeating the call is a no-op (`traceUpdated: 0`) instead of duplicating
 *     parts, because idempotent retries are how HTTP clients behave.
 *   - The trace parts are rendered with the same engine function assembly uses
 *     (`renderWorkingPaperTracePart`), and the version's `bodyHash` is
 *     recomputed over the resulting document, so the hash stays a true
 *     fingerprint of what the version now contains.
 */

const requestSchema = z.object({
  workingPaperRefs: z.array(z.string().trim().min(1)).min(1).max(50),
});

const TRACE_SOURCE = "workingPaper";
const TRACE_KIND = "workingPaperTrace";

interface TracePartRow {
  id: string;
  kind: string;
  ref: string | null;
  heading: string;
  bodyMarkdown: string;
  source: string | null;
  sourceRef: string | null;
  order: number;
  createdAt: Date;
}

/** The stored document body: exactly how the engine and render route build it. */
function assembleBody(parts: Array<{ heading: string; bodyMarkdown: string; order: number }>): string {
  return [...parts]
    .sort((a, b) => a.order - b.order)
    .map((p) => `## ${p.heading}\n\n${p.bodyMarkdown}`)
    .join("\n\n---\n\n");
}

function isTracedPart(part: { source: string | null; sourceRef: string | null; ref: string | null }): boolean {
  return part.source === TRACE_SOURCE && Boolean(part.ref ?? part.sourceRef);
}

async function loadVersion(engagementId: string, versionId: string) {
  const version = await prisma.engagementDeliverableVersion.findFirst({
    where: { id: versionId, engagementId },
    include: { parts: { orderBy: { order: "asc" } } },
  });
  if (!version) throw new ApiError(404, "NOT_FOUND", "Deliverable version not found.");
  return version;
}

/** Trace parts joined to their working papers, in document order. */
async function loadTraced(engagementId: string, versionId: string) {
  const parts = (await prisma.engagementDeliverablePart.findMany({
    where: { engagementId, versionId, source: TRACE_SOURCE },
    orderBy: { order: "asc" },
  })) as TracePartRow[];

  const paperIds = parts.map((p) => p.sourceRef).filter((id): id is string => Boolean(id));
  const papers = paperIds.length
    ? await prisma.workingPaper.findMany({
        where: { engagementId, id: { in: paperIds } },
        select: { id: true, indexRef: true, title: true, status: true, section: true, saReference: true },
      })
    : [];
  const byId = new Map(papers.map((p) => [p.id, p]));

  return parts.map((part) => {
    const paper = part.sourceRef ? byId.get(part.sourceRef) : undefined;
    return {
      partId: part.id,
      indexRef: paper?.indexRef ?? part.ref ?? "",
      title: paper?.title ?? part.heading,
      status: paper?.status ?? null,
      section: paper?.section ?? null,
      saReference: paper?.saReference ?? null,
      sourceRef: part.sourceRef,
      order: part.order,
      tracedAt: part.createdAt.toISOString(),
    };
  });
}

export async function GET(_request: Request, props: { params: Promise<{ id: string; versionId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { engagement } = await requireEngagementRole(ctx, params.id, "ASSISTANT");
    await loadVersion(engagement.id, params.versionId);

    const alreadyTraced = await loadTraced(engagement.id, params.versionId);
    return ok({
      versionId: params.versionId,
      alreadyTraced,
      workingPaperRefs: alreadyTraced.map((t) => t.indexRef),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string; versionId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const { role, engagement } = await requireEngagementRole(ctx, params.id, "ASSISTANT");
    if (!canPrepareWork(role)) {
      throw new ApiError(403, "FORBIDDEN", "Auditors have read-only access to deliverables.");
    }

    const body = await readJsonBody<Record<string, unknown>>(request);
    const requested = requestSchema.parse({ workingPaperRefs: body.workingPaperRefs }).workingPaperRefs;
    const refs = [...new Set(requested)];

    const version = await loadVersion(engagement.id, params.versionId);
    if (version.status !== "DRAFT") {
      throw new ApiError(
        409,
        "NOT_DRAFT",
        `Working-paper traceability is fixed once a deliverable leaves draft (this version is ${version.status}). Assemble a new revision instead.`,
      );
    }

    const papers = await prisma.workingPaper.findMany({
      where: { engagementId: engagement.id, indexRef: { in: refs } },
      select: { id: true, indexRef: true, title: true, status: true },
    });
    const byRef = new Map(papers.map((p) => [p.indexRef, p]));
    const unknownRefs = refs.filter((ref) => !byRef.has(ref));
    if (unknownRefs.length) {
      throw new ApiError(
        400,
        "VALIDATION",
        `Unknown working paper reference(s) for this engagement: ${unknownRefs.join(", ")}.`,
        { unknownRefs },
      );
    }

    const tracedParts = version.parts.filter(isTracedPart);
    const tracedRefs = new Set(tracedParts.map((p) => p.ref).filter((r): r is string => Boolean(r)));
    const tracedIds = new Set(tracedParts.map((p) => p.sourceRef).filter((id): id is string => Boolean(id)));
    const pending = refs.filter((ref) => {
      const paper = byRef.get(ref);
      return paper ? !tracedRefs.has(ref) && !tracedIds.has(paper.id) : false;
    });

    if (pending.length === 0) {
      const alreadyTraced = await loadTraced(engagement.id, params.versionId);
      return ok({
        versionId: version.id,
        traceUpdated: 0,
        parts: alreadyTraced,
        workingPaperRefs: alreadyTraced.map((t) => t.indexRef),
      });
    }

    const content = parseJson<Record<string, unknown>>(version.content, {});
    const storedPlaceholders = (content.placeholders as Record<string, string> | undefined) ?? {};
    const placeholders: PlaceholderValues = {};
    for (const [key, value] of Object.entries(storedPlaceholders)) {
      if (typeof value === "string") placeholders[key as keyof PlaceholderValues] = value;
    }
    const variant = version.variant === "REVIEWER" ? "REVIEWER" : "CLIENT";

    // Same loader + renderer assembly uses: one source of truth for trace text.
    const traces = await loadWorkingPapersForTrace(engagement.id, pending);
    if (traces.length !== pending.length) {
      throw new ApiError(
        409,
        "TRACE_MISMATCH",
        "A working paper could not be loaded for traceability. Retry the request.",
      );
    }

    const baseOrder = version.parts.reduce((max, part) => Math.max(max, part.order), -1) + 1;
    const created = await prisma.$transaction(async (tx) => {
      await tx.engagementDeliverablePart.createMany({
        data: traces.map((trace, index) => ({
          organizationId: engagement.organizationId,
          engagementId: engagement.id,
          versionId: version.id,
          kind: TRACE_KIND,
          ref: trace.wp.indexRef,
          heading: `Working paper: ${trace.wp.indexRef} \u2014 ${trace.wp.title}`,
          bodyMarkdown: renderWorkingPaperTracePart(trace, variant, placeholders),
          attachments: "[]",
          source: TRACE_SOURCE,
          sourceRef: trace.wp.id,
          order: baseOrder + index,
          createdById: ctx.user.id,
        })),
      });

      // Rebuild the stored body/hash from the rows themselves so the version's
      // fingerprint covers the evidence that was just attached.
      const parts = await tx.engagementDeliverablePart.findMany({
        where: { versionId: version.id },
        orderBy: { order: "asc" },
      });
      const body = assembleBody(parts);
      const bodyHash = hashContent(body);
      const nextContent = {
        ...content,
        parts: parts.map((p) => ({
          kind: p.kind,
          heading: p.heading,
          bodyMarkdown: p.bodyMarkdown,
          ref: p.ref,
          order: p.order,
        })),
        assembledBody: body,
      };
      await tx.engagementDeliverableVersion.update({
        where: { id: version.id },
        data: { content: stringifyJson(nextContent), bodyHash },
      });
      return { bodyHash };
    });

    await appendLedgerEntry(ctx, engagement, role, {
      action: "DELIVERABLE_TRACE_ADDED",
      targetType: "engagementDeliverableVersion",
      targetId: version.id,
      summary: `Traced ${pending.length} working paper${pending.length === 1 ? "" : "s"} on ${version.formatCode} rev ${version.revision}`,
      meta: { refs: pending, bodyHash: created.bodyHash },
    });

    const alreadyTraced = await loadTraced(engagement.id, version.id);
    return ok({
      versionId: version.id,
      traceUpdated: pending.length,
      parts: alreadyTraced,
      workingPaperRefs: alreadyTraced.map((t) => t.indexRef),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
