import { ApiError, requireAuth } from "@/lib/auth/guard";
import { notFoundError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { evaluateGate, type GatePolicy, type RegistryModel, type ModelStatus } from "@/lib/engine/mlops";
import { logActivity } from "@/lib/server/activity";
import { toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";
import { loadServeable } from "@/lib/server/model-serving";
import { moduleEnabledForRequest } from "@/lib/server/modules";
export const dynamic = "force-dynamic";

/**
 * POST /api/models/:id/promote — champion/challenger promotion.
 *
 * Body (all optional): {
 *   "policy":  { metric?, minImprovement?, guardrails?, maxRegression? },
 *   "note":    "why this version is being promoted"
 * }
 *
 * The gate is `lib/engine/mlops.ts:evaluateGate` — never vibes: the
 * challenger must meet the primary metric's `minImprovement` and every
 * guardrail tolerance, and promotion on rejection/hold is impossible. Every
 * row of the same registry line (workspace + name) is considered; on
 * PROMOTE the challenger becomes CHAMPION (stamped promotedAt/promotedBy +
 * the gate verdict note) and the incumbent is RETIRED with an audit note.
 * `hold`/`reject` change NOTHING — the response carries the gate record.
 *
 * Role: EDITOR — promotion changes what production serves.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const model = await prisma.modelVersion.findUnique({ where: { id: params.id } });
    if (!model) throw notFoundError("Model not found.");
    await requireRowRole(ctx, model, "EDITOR");

    if (!(await moduleEnabledForRequest("TRAINING_ENABLED"))) {
      throw new ApiError(503, "TRAINING_DISABLED", "Model promotion is disabled (TRAINING_ENABLED=false).");
    }

    const body = (await request.json().catch(() => null)) as { policy?: Partial<GatePolicy>; note?: string } | null;
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      throw new ApiError(400, "VALIDATION", 'Send { "policy": {...}, "note": "..." } or an empty body.');
    }
    if (body?.note && typeof body.note !== "string") {
      throw new ApiError(400, "VALIDATION", "note must be a string.");
    }

    // Registry line: every version of the same model (workspace + name),
    // newest first. Metrics arrive as a JSON string column.
    const line = await prisma.modelVersion.findMany({
      where: { workspaceId: model.workspaceId, name: model.name },
      orderBy: { version: "desc" },
    });
    const toRegistry = async (m: (typeof line)[number]): Promise<RegistryModel | null> => {
      let metrics: Record<string, number> = {};
      try {
        const decoded = JSON.parse(m.metrics) as Record<string, unknown>;
        for (const [k, v] of Object.entries(decoded)) {
          if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v;
        }
      } catch {
        metrics = {};
      }
      if (Object.keys(metrics).length === 0) return null;
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        // The engine's task union is wider than the column comment
        // (clustering included); pass through — the gate validates.
        task: m.task as RegistryModel["task"],
        algorithm: await algorithmOf(m),
        status: m.status as ModelStatus,
        targetColumn: m.targetColumn,
        featureNames: safeJsonArray(m.features),
        metrics,
        artifactJson: null,
        createdById: m.createdById,
        createdAt: m.createdAt.toISOString(),
        promotedAt: m.promotedAt ? m.promotedAt.toISOString() : null,
        promotedBy: m.promotedBy,
        note: m.note,
      };
    };

    const challenger = line.find((m) => m.id === model.id);
    if (!challenger) throw notFoundError("Model not found in its registry line.");
    if (challenger.status === "TRAINING" || challenger.status === "ERROR") {
      throw new ApiError(
        422,
        "NOT_READY",
        `A ${challenger.status} model cannot be gated — finish or re-train it first.`,
      );
    }
    const challengerReg = await toRegistry(challenger);
    if (!challengerReg) {
      throw new ApiError(422, "NO_METRICS", "This model has no finite metrics yet — train it fully before gating.");
    }

    const championRow = line.find((m) => m.status === "CHAMPION" && m.id !== model.id);
    const championReg = championRow ? await toRegistry(championRow) : null;
    if (championRow && !championReg) {
      throw new ApiError(
        422,
        "CHAMPION_UNSCORABLE",
        "The incumbent champion has no finite metrics — re-evaluate or retire it first.",
      );
    }

    const policy: GatePolicy = {
      ...(body?.policy ?? {}),
      minImprovement: body?.policy?.minImprovement ?? 0,
    };
    const gate = evaluateGate(championReg, challengerReg, policy);

    let promoted = false;
    let retiredChampionId: string | null = null;
    if (gate.verdict === "promote") {
      const note =
        (body?.note ? `${body.note} · ` : "") +
        `Gate: ${gate.metric} ${gate.challengerValue}${championReg ? ` (champion ${gate.championValue}, Δ ${gate.delta >= 0 ? "+" : ""}${gate.delta})` : " (first model)"} — ${gate.reasons.join(" ")}`;
      await prisma.$transaction(async (tx) => {
        if (championRow)
          await tx.modelVersion.update({
            where: { id: championRow.id },
            data: { status: "RETIRED", note: `Retired by promotion of v${challenger.version}.` },
          });
        return tx.modelVersion.update({
          where: { id: challenger.id },
          data: { status: "CHAMPION", promotedAt: new Date(), promotedBy: ctx.user.id, note },
        });
      });
      promoted = true;
      retiredChampionId = championRow?.id ?? null;
      await logActivity(
        ctx,
        "MODEL_PROMOTED",
        `Model “${model.name}” v${model.version} promoted to CHAMPION (${gate.metric} ${gate.challengerValue})`,
        model.projectId,
        { modelId: model.id, retiredChampionId },
      );
    }

    return Response.json({
      ok: true,
      data: {
        promoted,
        verdict: gate.verdict,
        gate,
        challenger: {
          id: challenger.id,
          name: challenger.name,
          version: challenger.version,
          status: promoted ? "CHAMPION" : challenger.status,
        },
        retiredChampionId,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * The algorithm never got its own column — it lives in the artifact JSON on
 * disk (ModelCard.algorithm). Read it for the gate's provenance; a missing
 * artifact degrades to "unknown" instead of failing the gate.
 */
async function algorithmOf(m: { id: string; task: string }): Promise<string> {
  try {
    const serveable = await loadServeable(m.id, m.task);
    return serveable.algorithm || "unknown";
  } catch {
    return "unknown";
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
