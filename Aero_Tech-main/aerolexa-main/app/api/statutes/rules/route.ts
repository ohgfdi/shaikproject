import { z } from "zod";

import { ApiError, requireAuth, type AuthContext } from "@/lib/auth/guard";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { canAuthorRegistry, prismaStatutesRepository, publishRuleVersion } from "@/lib/server/statutes";

export const dynamic = "force-dynamic";

const applicabilitySchema = z.object({
  ay: z.string().max(10).nullish(),
  entityTypes: z.array(z.string().max(40)).max(20).default([]),
  states: z.array(z.string().max(8)).max(40).default([]),
  scope: z.enum(["central", "state"]).default("central"),
});

const publishSchema = z.object({
  ruleKey: z.string().min(2),
  applicability: applicabilitySchema,
  unit: z.enum(["paise", "bps", "amount", "days", "months", "count", "text"]),
  rows: z.array(
    z.object({
      upTo: z.number().nullable(),
      rate: z.number(),
      label: z.string().max(80).optional(),
    }),
  ),
  valueSummary: z.string().min(1).max(200),
  citation: z.string().min(1).max(300),
  effectiveFrom: z.string().min(4).max(10),
  effectiveTo: z.string().min(4).max(10).nullish(),
  notificationId: z.string().nullish(),
  notes: z.string().max(600).nullish(),
});

function requireAuthor(ctx: AuthContext): void {
  if (!canAuthorRegistry(ctx)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Only a firm partner, manager or administrator can publish a rule version — every future filing computes from it.",
    );
  }
}

/** Every version of a rule (draft and published), newest first. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const ruleKey = new URL(request.url).searchParams.get("ruleKey") ?? undefined;
    const repo = await prismaStatutesRepository();
    return ok({ versions: await repo.listRuleVersions(ctx.workspace.id, ruleKey) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Publish a rule version. Publishing closes the window it replaces instead of
 * deleting history, so an as-on lookup for a past date still resolves what was
 * genuinely in force — that is what makes a filed number reproducible.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    requireAuthor(ctx);
    const body = publishSchema.parse(await readJsonBody<Record<string, unknown>>(request));
    const repo = await prismaStatutesRepository();
    const { version, closed } = await publishRuleVersion(repo, ctx.workspace.id, {
      ...body,
      applicability: {
        ay: body.applicability.ay ?? null,
        entityTypes: body.applicability.entityTypes,
        states: body.applicability.states,
        scope: body.applicability.scope,
      },
      effectiveTo: body.effectiveTo ?? null,
      notificationId: body.notificationId ?? null,
      notes: body.notes ?? null,
      publishedById: ctx.user.id,
    });
    await logActivity(
      ctx,
      "STATUTE_RULE_PUBLISHED",
      `Published ${version.ruleKey} v${version.version} (effective ${version.effectiveFrom})`,
      null,
      {
        ruleKey: version.ruleKey,
        version: version.version,
        effectiveFrom: version.effectiveFrom,
        closed: closed.length,
      },
    );
    return ok({ version, closed });
  } catch (err) {
    return toErrorResponse(err);
  }
}
