/**
 * Phase 34: SaaS Industry Template
 *
 * Pre-built metrics, KPIs, and compliance mappings for SaaS businesses.
 * Focuses on recurring revenue metrics, growth indicators, and operational efficiency.
 */
import type { NextRequest } from "next/server";


export interface SaaSKPI {
  id: string;
  name: string;
  label: string;
  type: "ratio" | "percentage" | "currency" | "count" | "time";
  aggregation: "sum" | "average" | "count" | "min" | "max";
  decimals: number;
  critical: boolean;
}

/** SaaS industry template - pre-configured for SaaS businesses. */
export const SaaSTemplate = {
  id: "saas",
  name: "Software as a Service",
  description: "SaaS businesses and subscription software analytics",

  kpis: [
    // Revenue metrics
    {
      id: "mrr",
      name: "Monthly Recurring Revenue",
      label: "MRR $",
      type: "currency",
      aggregation: "sum",
      decimals: 0,
      critical: true,
    },
    {
      id: "arr",
      name: "Annual Recurring Revenue",
      label: "ARR $",
      type: "currency",
      aggregation: "sum",
      decimals: 0,
      critical: true,
    },
    {
      id: "average_revenue_per_user",
      name: "Average Revenue Per User",
      label: "ARPU $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "average_revenue_per_paying_user",
      name: "Average Revenue Per Paying User",
      label: "ARPPU $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Growth metrics
    {
      id: "monthly_new_subscribers",
      name: "Monthly New Subscribers",
      label: "New Signups/month",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    {
      id: "monthly_expansions",
      name: "Monthly Expansions",
      label: "Expansions/month",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: false,
    },
    {
      id: "monthly_churns",
      name: "Monthly Churns",
      label: "Churns/month",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    // Retention metrics
    {
      id: "gross_margin",
      name: "Gross Margin",
      label: "Gross Margin %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "net_revenue_retention",
      name: "Net Revenue Retention",
      label: "NRR %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "gross_revenue_retention",
      name: "Gross Revenue Retention",
      label: "GRR %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Customer metrics
    {
      id: "total_customers",
      name: "Total Customers",
      label: "Customers",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: false,
    },
    {
      id: "active_trial_users",
      name: "Active Trial Users",
      label: "Trials Active",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    // Engagement metrics
    {
      id: "daily_active_users",
      name: "Daily Active Users",
      label: "DAU",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    {
      id: "monthly_active_users",
      name: "Monthly Active Users",
      label: "MAU",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    {
      id: "stickiness_ratio",
      name: "Stickiness Ratio",
      label: "DAU/MAU %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: false,
    },
  ],

  defaultCharts: [
    "funnel-analysis",
    "cohort-analysis",
    "retention-grid",
    "mrr-waterfall",
    "activation-dashboard",
  ],

  compliance: {
    hipaa: false,
    soc2: true, // Most SaaS companies pursue SOC2
    pci_dss: true, // If processing payments
    gdpr: true, // If serving EU customers
    customRequirements: ["CCPA", "LGPD"],
  },

  retentionDays: 1095, // 3 years (typical SaaS retention)
  enabledFeatures: [
    "advanced-charts",
    "pdf-export",
    "api-access",
    "custom-branding",
    "audit-logging",
    "feature-flags",
    "usage-tracking",
  ],

  theme: {
    primary: "#4f46e5", // Indigo - innovation
    secondary: "#10b981", // Emerald - growth
    accent: "#f97316", // Orange - attention/upsell
  },
};

/** Get the active industry template. */
export async function getIndustryTemplate(industry: string): Promise<unknown> {
  const templates: Record<string, unknown> = {
    saas: SaaSTemplate,
    finance: await import("./finance").then((m) => m.FinanceTemplate),
  };

  return templates[industry] || SaaSTemplate;
}

/** API route to get industry template. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";

    const template = await getIndustryTemplate(industry);

    return new Response(JSON.stringify(template), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Industry template error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve industry template" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}