import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { parseJson, stringifyJson } from "@/lib/json";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettings } from "@/lib/types";

const schema = z.object({
  name: z.string().min(1).max(160).optional(),
  settings: z
    .object({
      timezone: z.string().max(80).optional(),
      numberFormat: z.enum(["comma", "dot", "plain"]).optional(),
      dateFormat: z.enum(["short", "medium", "long"]).optional(),
      aiDemoMode: z.boolean().optional(),
      notificationTypes: z.array(z.string().max(40)).optional(),
    })
    .optional(),
});

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    if (body.name) {
      await prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { name: body.name } });
    }
    if (body.settings) {
      const current = parseJson<WorkspaceSettings>(ctx.workspace.settings, DEFAULT_WORKSPACE_SETTINGS);
      const merged: WorkspaceSettings = { ...current, ...body.settings };
      await prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { settings: stringifyJson(merged) } });
    }
    return ok({ updated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
