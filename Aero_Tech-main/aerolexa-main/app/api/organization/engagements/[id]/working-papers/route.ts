import { ApiError, requireAuth } from "@/lib/auth/guard";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { createWorkingPaper, listWorkingPapers, workingPaperIndexStatus } from "@/lib/server/governance";
import type { DataClassification } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Working papers for an engagement, with SA 230 binder completeness. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const [workingPapers, index] = await Promise.all([listWorkingPapers(ctx, id), workingPaperIndexStatus(ctx, id)]);
    return ok({ workingPapers, index });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Create a working paper with its first immutable version. */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{
      indexRef?: string;
      title?: string;
      section?: string;
      saReference?: string;
      classification?: DataClassification;
      content?: unknown;
      changeSummary?: string;
    }>(request);
    if (!body.indexRef) throw new ApiError(400, "VALIDATION", "indexRef is required.");
    if (!body.title) throw new ApiError(400, "VALIDATION", "title is required.");
    const workingPaper = await createWorkingPaper(ctx, id, {
      indexRef: body.indexRef,
      title: body.title,
      section: body.section,
      saReference: body.saReference,
      classification: body.classification,
      content: body.content,
      changeSummary: body.changeSummary,
    });
    return ok({ workingPaper }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
