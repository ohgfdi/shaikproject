import { requireAuth } from "@/lib/auth/guard";
import { complianceTaskState, ComplianceTaskState, daysUntil } from "@/lib/engine/compliance-calendar";
import { ok, toErrorResponse } from "@/lib/server/api";
import { getComplianceCalendar } from "@/lib/server/compliance-calendar";
import { mapOrgRoleToProjectRole } from "@/lib/server/members";
import { runSoxCheck } from "@/lib/compliance/sox";
import { runSoc2Assessment } from "@/lib/compliance/soc2-controls";
import { runGdprAssessment } from "@/lib/compliance/gdpr-controls";
import { hasPermission, getEffectivePermissions, RoleKey, Permission } from "@/lib/rbac/permissions";
import { getPartnerTiers, PartnerTier, PartnerTierDefinition, PartnerProfile } from "@/lib/partner/partner-tiers";
import { generateRecommendations, getMetricSummary } from "@/lib/ai/prescriptive-analytics";
import { calculateCommission, canPartnerCloseDeal, CommissionCalculation, PartnerPayoutSummary } from "@/lib/partner/revenue-share";
import { detectAnomalies, getAnomalyStats, AnomalyEvent, AnomalyStats, AnomalySeverity, AnomalyType } from "@/lib/ai/anomaly-detection";
import { interpretQuery, generateInsight, InsightType, InsightConfidence, Insight, ChartConfig, InsightAction } from "@/lib/ai/natural-language-insight";

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

      if (action === "partner:tiers") {
        return new Response(JSON.stringify(getPartnerTiers()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "partner:eligible") {
        const tier = (searchParams.get("tier") || "startup") as PartnerTier;
        const arR = parseFloat(searchParams.get("arR") || "0");
        const customerCount = parseInt(searchParams.get("customerCount") || "0", 10);
        const tierDef = PARTNER_TIER_DEFINITIONS[tier];
        const eligible = arR >= tierDef.requiredARR && customerCount >= tierDef.requiredCustomers;
        return new Response(JSON.stringify({ tier, eligible, requiredARR: tierDef.requiredARR, requiredCustomers: tierDef.requiredCustomers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "partner:profile") {
        const companyName = searchParams.get("companyName") || "";
        const tier = (searchParams.get("tier") || "startup") as PartnerTier;
        const status = searchParams.get("status") || "pending";
        const profile: PartnerProfile = {
          id: "partner_" + Date.now(),
          companyName,
          tier,
          status: status as PartnerStatus,
          arR: parseFloat(searchParams.get("arR") || "0"),
          customerCount: parseInt(searchParams.get("customerCount") || "0", 10),
          annualRevenue: parseFloat(searchParams.get("annualRevenue") || "0"),
          contactName: searchParams.get("contactName") || "",
          contactEmail: searchParams.get("contactEmail") || "",
          country: searchParams.get("country") || "",
          website: searchParams.get("website") || undefined,
          integrationStatus: searchParams.get("integrationStatus") as any || undefined,
          registeredDeals: parseInt(searchParams.get("registeredDeals") || "0", 10),
          closedDeals: parseInt(searchParams.get("closedDeals") || "0", 10),
          totalEarnings: parseFloat(searchParams.get("totalEarnings") || "0"),
          lastActivityDate: new Date(),
          metadata: {},
        };
        return new Response(JSON.stringify(profile), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "partner:recommendations") {
        const metricId = searchParams.get("metricId") || "metrics_001";
        const metricName = searchParams.get("metricName") || "Revenue";
        const currentValue = parseFloat(searchParams.get("currentValue") || "0");
        const trend = (searchParams.get("trend") || "up") as "up" | "down" | "stable";
        const recommendations = generateRecommendations(metricId, metricName, currentValue, trend);
        return new Response(JSON.stringify({ recommendations }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "partner:metric") {
        const metricId = searchParams.get("metricId") || "metrics_001";
        const metricName = searchParams.get("metricName") || "Revenue";
        const currentValue = parseFloat(searchParams.get("currentValue") || "0");
        const trend = (searchParams.get("trend") || "up") as "up" | "down" | "stable";
        const summary = getMetricSummary(metricId, metricName, currentValue, trend);
        return new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "partner:commission") {
        const tier = (searchParams.get("tier") || "growth") as CommissionTier;
        const revenue = parseFloat(searchParams.get("revenue") || "0");
        const calculation = calculateCommission(tier, revenue);
        return new Response(JSON.stringify(calculation), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "partner:eligibility") {
        const tier = (searchParams.get("tier") || "growth") as CommissionTier;
        const arR = parseFloat(searchParams.get("arR") || "0");
        const customerCount = parseInt(searchParams.get("customerCount") || "0", 10);
        const windows = { startup: 90, growth: 60, enterprise: 30, elite: 14 };
        const minARR = tier === "startup" ? 0 : tier === "growth" ? 100000 : tier === "enterprise" ? 500000 : 2000000;
        const minCustomers = tier === "startup" ? 0 : tier === "growth" ? 5 : tier === "enterprise" ? 15 : 50;
        const eligible = arR >= minARR && customerCount >= minCustomers;
        return new Response(JSON.stringify({ tier, eligible, minARR, minCustomers, registrationWindowDays: windows[tier] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "anomaly:detect") {
        const metricId = searchParams.get("metricId") || "metrics_001";
        const metricName = searchParams.get("metricName") || "Revenue";
        const currentValue = parseFloat(searchParams.get("currentValue") || "0");
        const historicalStr = searchParams.get("historical");
        const historicalValues = historicalStr
          ? historicalStr.split(",").map((v: string) => parseFloat(v)).filter((v: number) => !isNaN(v))
          : [];
        const upperStr = searchParams.get("upperThreshold");
        const lowerStr = searchParams.get("lowerThreshold");
        const upperThreshold = upperStr ? parseFloat(upperStr) : Infinity;
        const lowerThreshold = lowerStr ? parseFloat(lowerStr) : -Infinity;

        const anomalies = detectAnomalies(metricId, metricName, currentValue, historicalValues, {
          upper: upperThreshold,
          lower: lowerThreshold,
        });
        const stats = getAnomalyStats(anomalies);
        return new Response(JSON.stringify({ anomalies, stats }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "anomaly:stats") {
        const eventsStr = searchParams.get("events");
        const events = eventsStr
          ? eventsStr.split(";").map((e: string) => {
              const [id, metricId, metricName, type, severity, current, expected, devPct, detected, status] = e.split("|");
              return { id, metricId, metricName, type: type as AnomalyType, severity: severity as AnomalySeverity, currentValue: parseFloat(current), expectedValue: parseFloat(expected), deviationPercentage: parseFloat(devPct), detectedAt: new Date(detected), status: status as "active" | "resolved" | "dismissed" };
            }).filter((e) => e.metricId) || [];
        const stats = getAnomalyStats(events);
        return new Response(JSON.stringify({ events, stats }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "nl:interpret") {
        const query = searchParams.get("query") || "Show me trends";
        const interpretation = interpretQuery(query);
        return new Response(JSON.stringify({ interpretation }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (action === "nl:generate") {
        const type = (searchParams.get("type") || "trend") as InsightType;
        const query = searchParams.get("query") || "Show me trends";
        const extracted = interpretQuery(query);
        const contextData = {
          totalCustomers: 1247,
          monthlyRevenue: 450000,
          activeExperiments: 3,
        };
        const insight = generateInsight(type, extracted, contextData);
        return new Response(JSON.stringify(insight), {
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
