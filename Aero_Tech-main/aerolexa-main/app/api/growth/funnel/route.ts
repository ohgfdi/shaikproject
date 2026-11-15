import { requireAuth, forbiddenError } from "@/lib/auth/guard";
import { ok, toErrorResponse } from "@/lib/server/api";
import { activationVerdict, weeklyFunnel } from "@/lib/server/growth-funnel";
import { practiceStall } from "@/lib/server/practice-funnel";
import { practiceFunnelSnapshot } from "@/lib/server/practice-funnel-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/growth/funnel?weeks=12
 *
 * Weekly activation funnel (signups → activated → collaborated → paid),
 * computed from the Activity trail + subscriptions. Operator-only: the
 * workspace OWNER role is required (in a single-tenant deployment that is
 * the operator; on a hosted instance it is the account holder seeing their
 * own conversion context — extend with a global OPERATOR_EMAILS allowlist
 * when a multi-tenant support org exists).
 *
 * Honest labelling: rates are null (not 0) when a denominator is 0, so
 * "no signups this week" never renders as "0% converted".
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const role = ctx.organizationRole ?? "OWNER";
    // Only OWNER/ADMIN see funnel data — it is business-sensitive.
    if (role !== "OWNER" && role !== "ADMIN") {
      throw forbiddenError("Funnel metrics are operator-only.");
    }

    const url = new URL(request.url);
    const weeksRaw = Number(url.searchParams.get("weeks") ?? 12);
    const weeks = Number.isInteger(weeksRaw) && weeksRaw >= 1 && weeksRaw <= 52 ? weeksRaw : 12;

    const [rows, practice] = await Promise.all([weeklyFunnel(weeks), practiceFunnelSnapshot()]);
    const latest = rows[rows.length - 1];

    return ok({
      weeks,
      rows,
      latest,
      // CA-firm value chain: the first missing step is the next build. This is
      // the evidence Horizon 3 is decided by — not feature coverage.
      practice: { counts: practice, ...practiceStall(practice) },
      verdict: activationVerdict(latest?.activationRate ?? null),
      definitions: {
        activated: "uploaded a dataset AND ran an analysis in their workspace",
        collaborated: "added an org member or published a public share link",
        paid: "holds an active paid (non-free) subscription",
        cohort: "attributed to the signup week, not the event week",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
