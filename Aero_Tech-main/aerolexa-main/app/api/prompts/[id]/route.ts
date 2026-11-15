import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireModule } from "@/lib/server/modules";
import { extractVariables, toItem } from "@/lib/server/prompts";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("PROMPTS_ENABLED");
    const ctx = await requireAuth();
    const prompt = await prisma.prompt.findUnique({ where: { id: params.id } });
    if (!prompt || prompt.workspaceId !== ctx.workspace.id) throw new ApiError(404, "NOT_FOUND", "Prompt not found.");
    const body = await readJsonBody<{
      name?: string;
      description?: string | null;
      template?: string;
      isAdvisorTemplate?: boolean;
      chain?: string[];
    }>(request);
    const data: {
      name?: string;
      description?: string | null;
      template?: string;
      variables?: string;
      isAdvisorTemplate?: boolean;
      chain?: string;
    } = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 120);
    if ("description" in body)
      data.description = body.description?.trim() ? body.description.trim().slice(0, 300) : null;
    if (typeof body.template === "string") {
      if (body.template.length > 20_000)
        throw new ApiError(400, "VALIDATION", "Template is too long (max 20 000 characters).");
      data.template = body.template;
      data.variables = stringifyJson(extractVariables(body.template));
    }
    if (typeof body.isAdvisorTemplate === "boolean") data.isAdvisorTemplate = body.isAdvisorTemplate;
    if (Array.isArray(body.chain)) {
      data.chain = stringifyJson(body.chain.filter((c): c is string => typeof c === "string").slice(0, 10));
    }
    const updated = await prisma.prompt.update({ where: { id: prompt.id }, data });
    await logActivity(ctx, "PROMPT_UPDATED", `Prompt “${updated.name}” updated`);
    return ok({ prompt: toItem(updated) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("PROMPTS_ENABLED");
    const ctx = await requireAuth();
    const prompt = await prisma.prompt.findUnique({ where: { id: params.id } });
    if (!prompt || prompt.workspaceId !== ctx.workspace.id) throw new ApiError(404, "NOT_FOUND", "Prompt not found.");
    await prisma.prompt.delete({ where: { id: prompt.id } });
    await logActivity(ctx, "ARTIFACT_DELETED", `Prompt “${prompt.name}” deleted`);
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
