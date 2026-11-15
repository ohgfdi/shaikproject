import { requireAuth } from "@/lib/auth/guard";
import { complianceTaskState, ComplianceTaskState, daysUntil } from "@/lib/engine/compliance-calendar";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getComplianceCalendar } from "@/lib/server/compliance-calendar";
import { mapOrgRoleToProjectRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

/** GET /api/organization/compliance — the firm's statutory calendar with advanced analytics. */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const today = new URL(request.url).searchParams.get("today") ?? undefined;
    const calendar = await getComplianceCalendar(ctx, { today });

    // Compute analytics summary
    const tasks = calendar.tasks || [];
    const totals = {
      overdue: 0,
      dueSoon: 0,
      upcoming: 0,
      filed: 0,
      waived: 0,
      clients: calendar.clients?.length ?? 0,
    };
    for (const task of tasks) {
      const state = task.state as ComplianceTaskState;
      if (state === "overdue") totals.overdue++;
      else if (state === "due-soon") totals.dueSoon++;
      else if (state === "upcoming") totals.upcoming++;
      else if (state === "filed") totals.filed++;
      else if (state === "waived") totals.waived++;
    }

    // Due date distribution
    const dueDistribution = tasks.reduce((acc: any, task: any) => {
      const state = task.state;
      if (!acc[state]) acc[state] = 0;
      acc[state]++;
      return acc;
    }, {});

    // Risk scoring: count overdue + due-soon as high risk
    const riskScore = {
      high: totals.overdue + totals.dueSoon,
      medium: totals.upcoming,
      low: totals.filed + totals.waived,
    };

    // Upcoming deadlines in next 30 days (using daysUntil from compliance-calendar)
    const upcoming30Days = tasks.filter((task: any) => {
      const diff = daysUntil(task.dueDate, today ?? new Date().toISOString().slice(0, 10));
      return diff >= 0 && diff <= 30;
    });
    const upcoming30DaysCount = upcoming30Days.length;

    // By authority breakdown
    const authorityBreakdown = tasks.reduce((acc: any, task: any) => {
      const auth = task.authority;
      if (!acc[auth]) acc[auth] = 0;
      acc[auth]++;
      return acc;
    }, {});

    // State breakdown
    const stateBreakdown = tasks.reduce((acc: any, task: any) => {
      const state = task.state;
      if (!acc[state]) acc[state] = 0;
      acc[state]++;
      return acc;
    }, {});

    // Clients with most obligations
    const clientCounts: Record<string, number> = tasks.reduce((acc: any, task: any) => {
      const clientId = task.clientId;
      acc[clientId] = (acc[clientId] ?? 0) + 1;
      return acc;
    }, {});
    const topClients = Object.entries(clientCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([clientId, count]) => ({ clientId, count }));

    return ok({ calendar, totals, dueDistribution, riskScore, upcoming30DaysCount, authorityBreakdown, stateBreakdown, topClients });
  } catch (err) {
    return toErrorResponse(err);
  }
}
