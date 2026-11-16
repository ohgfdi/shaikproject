import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  computeRiskScore,
  forecastDeadlines,
  summarizeTasksByState,
} from "@/lib/engine/compliance-notifications";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getComplianceCalendar } from "@/lib/server/compliance-calendar";

export const dynamic = "force-dynamic";

/**
 * Firm compliance snapshot.
 *
 * This route used to generate a calendar for a hard-coded demo client
 * (`client_demo_001` / "Sharma Textiles Pvt Ltd"), send SMS to a hard-coded
 * number on every POST, and count attempts as sends. It is now a read-only view
 * over the same tenanted calendar the compliance screen uses — one source of
 * truth, no side effects.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const today = new URL(request.url).searchParams.get("today") ?? undefined;
    const calendar = await getComplianceCalendar(ctx, { today });

    const summary = summarizeTasksByState(calendar.tasks);
    const riskScore = computeRiskScore(calendar.tasks);
    const forecast = forecastDeadlines(calendar.tasks);

    return ok({
      asOf: calendar.asOf,
      financialYear: calendar.financialYear,
      totals: calendar.totals,
      riskScore,
      summary: {
        overdue: summary.overdue.length,
        dueSoon: summary.dueSoon.length,
        upcoming: summary.upcoming.length,
        filed: calendar.totals.filed,
        waived: calendar.totals.waived,
      },
      forecast: {
        criticalDeadlines: forecast.critical.length,
        warningDeadlines: forecast.warning.length,
        upcomingDeadlines: forecast.upcoming.length,
        next30Days: forecast.next30Days,
        severityTrend: forecast.severityTrend,
        trendBasis: forecast.trendBasis,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST is no longer a delivery trigger; direct callers to the calendar route. */
export async function POST(request: Request) {
  const handler = await import("@/lib/compliance/reporting");
  return handler.POST(request);
}
