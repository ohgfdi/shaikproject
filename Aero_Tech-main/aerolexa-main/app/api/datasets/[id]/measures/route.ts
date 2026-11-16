/**
 * tenancy-audit: global-operator — dataset measures API provides persistent
 * named DAX measures on a workspace dataset. This is a deployment-wide aggregate
 * rather than a per-tenant query.
 */

* GET/POST /api/datasets/[id]/measures
 *
 * Persistent, named DAX measures on a dataset (Power BI "model measures" —
 * defined once, reused in any visual). Stored as JSON { name → expression }
 * in Dataset.measures. POST validates the expression by RUNNING it against a
 * one-row model (parse errors surface, wrong columns surface) — a measure
 * that cannot evaluate is never saved.
 */
import { z } from "zod";

import { requireAuth, notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { validateMeasure } from "@/lib/engine/dax";
import { parseJson, stringifyJson } from "@/lib/json";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { badRequest } from "@/lib/server/pbi-frame";

const schema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[\w][\w \-]*$/, "Measure names must start with a letter/digit and use letters, digits, spaces, dashes."),
  expression: z.string().min(3).max(2000),
});

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { id: true, workspaceId: true, projectId: true, measures: true },
    });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "VIEWER");
    return ok({ measures: parseJson<Record<string, string>>(dataset.measures, {}) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const dataset = await prisma.dataset.findUnique({
      where: { id: params.id },
      select: { id: true, workspaceId: true, projectId: true, measures: true, name: true },
    });
    if (!dataset) throw notFoundError("Dataset not found.");
    await requireRowRole(ctx, dataset, "EDITOR");

    const errors = validateMeasure(body.expression);
    if (errors.length) throw badRequest(`DAX does not parse: ${errors[0]}`);

    const measures = { ...parseJson<Record<string, string>>(dataset.measures, {}), [body.name]: body.expression };
    const updated = await prisma.dataset.update({
      where: { id: dataset.id },
      data: { measures: stringifyJson(measures) },
    });
    await logActivity(
      ctx,
      "DATASET_UPDATED",
      `Measure “[${body.name}]” saved on dataset “${dataset.name}”`,
      dataset.projectId,
      { datasetId: dataset.id },
    );
    return ok({ measures: parseJson<Record<string, string>>(updated.measures, {}) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
