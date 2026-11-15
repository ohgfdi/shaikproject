/**
 * Per-organization assistant switch.
 *
 * GET  — owners/admins can read the effective setting.
 * PUT  — owners/admins can enable/disable the assistant for their organization.
 *
 * The global operator kill switch (`ASSISTANT_ENABLED`) is env-only and cannot
 * be overridden from this route.
 */

import { z } from "zod";

import { getAssistantOrganizationSetting, setAssistantOrganizationEnabled } from "@/lib/ai/settings";
import { ApiError, requireAuth, requireOrganizationRole } from "@/lib/auth/guard";
import { serverEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

function requireOrg(auth: Awaited<ReturnType<typeof requireAuth>>) {
  if (!auth.organization)
    throw new ApiError(
      400,
      "NO_ORGANIZATION",
      "Select an organization first; personal workspaces have no assistant switch.",
    );
  return auth.organization;
}

export async function GET(): Promise<Response> {
  let auth;
  try {
    auth = await requireAuth();
    const org = requireOrg(auth);
    requireOrganizationRole(auth, org.id, ["OWNER", "ADMIN"], "assistant settings");
  } catch (error) {
    if (error instanceof ApiError) return fail(error.status, error.code, error.message);
    return fail(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }
  const org = auth.organization!;
  const env = serverEnv();
  const row = await getAssistantOrganizationSetting(org.id);
  return Response.json(
    {
      ok: true,
      data: {
        organizationId: org.id,
        enabled: row ? row.enabled : env.ASSISTANT_ORGANIZATION_DEFAULT_ENABLED,
        source: row ? "organization" : "deployment_default",
        globalEnabled: env.ASSISTANT_ENABLED,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

const bodySchema = z.object({ enabled: z.boolean() }).strict();

export async function PUT(request: Request): Promise<Response> {
  let auth;
  try {
    auth = await requireAuth();
    const org = requireOrg(auth);
    requireOrganizationRole(auth, org.id, ["OWNER", "ADMIN"], "assistant settings");
  } catch (error) {
    if (error instanceof ApiError) return fail(error.status, error.code, error.message);
    return fail(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "INVALID_JSON", "The request body must be JSON.");
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail(400, "VALIDATION", "enabled must be a boolean and no other fields are accepted.");

  const org = auth.organization!;
  const row = await setAssistantOrganizationEnabled({
    organizationId: org.id,
    enabled: parsed.data.enabled,
    updatedById: auth.user.id,
  });
  return Response.json(
    { ok: true, data: { organizationId: org.id, enabled: row.enabled, updatedAt: row.updatedAt.toISOString() } },
    { headers: { "cache-control": "no-store" } },
  );
}
