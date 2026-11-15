import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireModule } from "@/lib/server/modules";
import { extractVariables, toItem } from "@/lib/server/prompts";
import type { PromptDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_TEMPLATE = 20_000;

export async function GET() {
  try {
    requireModule("PROMPTS_ENABLED");
    const ctx = await requireAuth();
    const rows = await prisma.prompt.findMany({
      where: { workspaceId: ctx.workspace.id },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return ok({ prompts: rows.map(toItem) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    requireModule("PROMPTS_ENABLED");
    const ctx = await requireAuth();
    const body = await readJsonBody<PromptDraft>(request);
    const name = (body.name ?? "").trim();
    const template = (body.template ?? "").trim();
    if (!name || name.length > 120) throw new ApiError(400, "VALIDATION", "Name the prompt (max 120 characters).");
    if (!template) throw new ApiError(400, "VALIDATION", "Write the prompt template text.");
    if (template.length > MAX_TEMPLATE)
      throw new ApiError(400, "VALIDATION", "Template is too long (max 20 000 characters).");
    const chain = validateChain(body.chain);

    const prompt = await prisma.prompt.create({
      data: {
        workspaceId: ctx.workspace.id,
        name,
        description: body.description?.trim() ? body.description.trim().slice(0, 300) : null,
        template,
        variables: stringifyJson(extractVariables(template)),
        chain: stringifyJson(chain),
        isAdvisorTemplate: body.isAdvisorTemplate === true,
        createdById: ctx.user.id,
      },
    });
    await logActivity(ctx, "PROMPT_CREATED", `Prompt “${prompt.name}” created`);
    return ok({ prompt: toItem(prompt) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function validateChain(chain: unknown): string[] {
  if (!Array.isArray(chain)) return [];
  return chain.filter((c): c is string => typeof c === "string").slice(0, 10);
}
