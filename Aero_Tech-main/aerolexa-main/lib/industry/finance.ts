/**
 * Phase 33: Finance Industry Template
 *
 * Pre-built metrics, KPIs, and compliance mappings for Financial Services.
 * Complements the multi-tenant SaaS isolation (Phase 24) with industry-specific defaults.
 */
import { prisma } from "../lib/db";
import type { NextRequest } from "next/server";

export type Industry = "finance" | "healthcare" | "saas" | "retail" | "manufacturing";

export interface IndustryTemplate {
  id: Industry;
  name: string;
  description: string;
  // Pre-built KPIs
  kpis: IndustryKPI[];
  // Default chart configurations
  defaultCharts: string[];
  // Compliance mappings
  compliance: IndustryCompliance;
  // Data retention defaults (days)
  retentionDays: number;
  // Feature flags enabled by default
  enabledFeatures: string[];
  // Color theme for this industry
  theme: {
    primary: string;
    secondary: string;
    accent: string;
  };
}

export interface IndustryKPI {
  id: string;
  name: string;
  label: string;
  // Formula or metric type
  type: "ratio" | "percentage" | "currency" | "count" | "time";
  // Default aggregation
  aggregation: "sum" | "average" | "count" | "min" | "max";
  // Decimals for display
  decimals: number;
  // Whether this is a critical KPI (triggers alerts)
  critical: boolean;
}

export interface IndustryCompliance {
  hipaa: boolean; // applicable?
  soc2: boolean; // applicable?
  pci_dss: boolean; // applicable?
  gdpr: boolean; // applicable?
  customRequirements: string[];
}

/** Finance industry template - pre-configured for financial services. */
export const FinanceTemplate: IndustryTemplate = {
  id: "finance",
  name: "Financial Services",
  description: "Banking, investment, and financial services analytics",

  kpis: [
    // Financial performance KPIs
    {
      id: "roi",
      name: "Return on Investment",
      label: "ROI %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "cac",
      name: "Customer Acquisition Cost",
      label: "CAC $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "ltv",
      name: "Customer Lifetime Value",
      label: "LTV $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "churn",
      name: "Customer Churn Rate",
      label: "Churn %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Growth metrics
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
      id: "mrr",
      name: "Monthly Recurring Revenue",
      label: "MRR $",
      type: "currency",
      aggregation: "sum",
      decimals: 0,
      critical: true,
    },
    // Efficiency metrics
    {
      id: "ctr",
      name: "Conversion Rate",
      label: "Conversion %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: false,
    },
    {
      id: "cpa",
      name: "Cost Per Acquisition",
      label: "CPA $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: false,
    },
  ],

  defaultCharts: [
    "revenue-waterfall",
    "funnel-analysis",
    "risk-dashboard",
    "portfolio-performance",
  ],

  compliance: {
    hipaa: false,
    soc2: true, // Financial services typically pursue SOC2
    pci_dss: true, // If processing payments
    gdpr: true, // If serving EU customers
    customRequirements: ["SOX", "Basel-III", "Dodd-Frank"],
  },

  retentionDays: 2555, // 7 years (SOX/compliance typical)
  enabledFeatures: [
    "advanced-charts",
    "pdf-export",
    "api-access",
    "custom-branding",
    "audit-logging",
    "risk-monitoring",
  ],

  theme: {
    primary: "#1a73e8", // Google Blue - finance trust
    secondary: "#34a853", // Green - growth
    accent: "#ea4335", // Red - warnings/losses
  },
};

/** Get the active industry template. */
export function getIndustryTemplate(industry: Industry): IndustryTemplate {
  const templates: Record<Industry, IndustryTemplate> = {
    finance: FinanceTemplate,
    // Other templates will be added in subsequent phases
    // healthcare: HealthcareTemplate,
    // saas: SaaSTemplate,
    // retail: RetailTemplate,
    // manufacturing: ManufacturingTemplate,
  };

  return templates[industry] || FinanceTemplate; // Default to finance
}

/** Get KPI by ID from a template. */
export function getKPIById(
  template: IndustryTemplate,
  kpiId: string
): IndustryKPI | undefined {
  return template.kpis.find((kpi) => kpi.id === kpiId);
}

/** Get a KPI's formatted value based on its type. */
export function formatKPIValue(
  kpi: IndustryKPI,
  value: number | string
): string {
  switch (kpi.type) {
    case "percentage":
      return typeof value === "number" ? `${value.toFixed(kpi.decimals)}%` : `${value}%`;
    case "currency":
      return typeof value === "number"
        ? `$${value.toFixed(kpi.decimals)}`
        : `$${value}`;
    case "count":
      return typeof value === "number" ? `${value.toLocaleString()}` : String(value);
    case "time":
      return typeof value === "object"
        ? value.toISOString()
        : String(value);
    default:
      return String(value);
  }
}

/** API route to get industry template. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "finance";

    const template = getIndustryTemplate(industry as Industry);

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