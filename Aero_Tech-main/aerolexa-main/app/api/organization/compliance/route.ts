import { requireAuth } from "@/lib/auth/guard";
import { complianceTaskState, ComplianceTaskState, daysUntil } from "@/lib/engine/compliance-calendar";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getComplianceCalendar } from "@/lib/server/compliance-calendar";
import { mapOrgRoleToProjectRole } from "@/lib/server/members";
import { runSoxCheck } from "@/lib/compliance/sox";
import { runSoc2Assessment } from "@/lib/compliance/soc2-controls";
import { runGdprAssessment } from "@/lib/compliance/gdpr-controls";
import { hasPermission, getEffectivePermissions, RoleKey, Permission } from "@/lib/rbac/permissions";

export const dynamic = "force-dynamic";

/** GET /api/organization/compliance — the firm's statutory calendar with advanced analytics. */
export async function GET(request: Request) {
    try {
      const ctx = await requireAuth();
      const searchParams = new URL(request.url).searchParams;
      const action = searchParams.get("action") || "calendar";

      if (action === "sox") {
        return new Response(
          JSON.stringify(runSoxCheck()),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (action === "soc2") {
        return new Response(
          JSON.stringify(runSoc2Assessment()),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (action === "gdpr") {
        return new Response(
          JSON.stringify(runGdprAssessment()),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (action === "rbac:roles") {
        const roles = Object.keys(ROLE_DEFINITIONS as any).map((key: any) => ({
          key,
          ...(ROLE_DEFINITIONS as any)[key],
        }));
        return new Response(JSON.stringify({ roles }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "rbac:check") {
        const role = searchParams.get("role") as RoleKey || "member";
        const permission = searchParams.get("permission") as Permission || "read:own profile";
        const scope = searchParams.get("scope") as "own" | "team" | "organization" | "all" || "own";
        const result = hasPermission(role, permission, scope);
        return new Response(JSON.stringify({ role, permission, scope, hasPermission: result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "rbac:effective") {
        const role = searchParams.get("role") as RoleKey || "member";
        const scope = searchParams.get("scope") as "own" | "team" | "organization" | "all" || "own";
        const result = getEffectivePermissions(role, scope);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const today = searchParams.get("today") ?? undefined;
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
