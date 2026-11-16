/**
 * Phase 48: Vertical-Specific Data Templates with Pre-Built Report Layouts
 *
 * Pre-built report templates, layout configurations, and export formats optimized
 * for each industry vertical. Integrates with the industry data models (Phase 41)
 * and dashboard configurations (Phase 39) for end-to-end report generation.
 */
import { prisma } from "../lib/db";
import type { NextRequest } from "next/server";
import { getIndustryTemplate } from "./";
import { getIndustryDashboardConfig } from "../components/industry/dashboard-configs";

export type Industry = "finance" | "healthcare" | "saas" | "retail" | "manufacturing";

export type ReportType =
  | "executive-summary"
  | "detailed-analysis"
  | "compliance-report"
  | "export-format"
  | "pdf-export"
  | "html-embed";

export interface ReportTemplate {
  id: string;
  name: string;
  industry: Industry;
  type: ReportType;
  // Layout configuration
  layout: "grid" | "list" | "card" | "timeline" | "funnel";
  // Widgets configured for this template
  widgets: string[]; // widget IDs from dashboard configs
  // Data aggregation settings
  aggregation: "sum" | "average" | "count" | "min" | "max";
  // Time range defaults
  default_time_range: "last_7_days" | "last_30_days" | "last_90_days" | "year_to_date" | "custom";
  // Export format options
  export_formats: ("pdf" | "excel" | "csv" | "json")[];
  // Branding overrides allowed
  allow_branding: boolean;
  // Compliance watermark
  compliance_watermark?: boolean;
  // Minimum plan required
  min_plan: "free" | "pro" | "enterprise";
}

/** Finance report templates. */
export const FinanceReportTemplates: ReportTemplate[] = [
  {
    id: "finance-executive",
    name: "Executive Summary",
    industry: "finance",
    type: "executive-summary",
    layout: "grid",
    widgets: ["roi-kpi", "arr-kpi", "cac-kpi", "churn-kpi", "revenue-funnel"],
    aggregation: "average",
    default_time_range: "year_to_date",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "pro",
  },
  {
    id: "finance-compliance",
    name: "Compliance Report",
    industry: "finance",
    type: "compliance-report",
    layout: "list",
    widgets: ["compliance-status", "risk-dashboard", "audit-log-table"],
    aggregation: "sum",
    default_time_range: "custom",
    export_formats: ["pdf"],
    allow_branding: false,
    compliance_watermark: true,
    min_plan: "enterprise",
  },
  {
    id: "finance-risk",
    name: "Risk Dashboard",
    industry: "finance",
    type: "detailed-analysis",
    layout: "funnel",
    widgets: ["risk-dashboard", "portfolio-performance", "credit-quality"],
    aggregation: "average",
    default_time_range: "last_90_days",
    export_formats: ["pdf", "excel", "json"],
    allow_branding: true,
    min_plan: "pro",
  },
];

/** SaaS report templates. */
export const SaaSReportTemplates: ReportTemplate[] = [
  {
    id: "saas-executive",
    name: "Executive Summary",
    industry: "saas",
    type: "executive-summary",
    layout: "grid",
    widgets: ["mrr-kpi", "arr-kpi", "nrr-kpi", "dau-kpi", "funnel-analysis"],
    aggregation: "sum",
    default_time_range: "last_30_days",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "pro",
  },
  {
    id: "saas-cohort",
    name: "Cohort Analysis",
    industry: "saas",
    type: "detailed-analysis",
    layout: "grid",
    widgets: ["cohort-analysis", "retention-grid", "activation-dashboard"],
    aggregation: "average",
    default_time_range: "last_90_days",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "enterprise",
  },
  {
    id: "saas-churn",
    name: "Churn Analysis",
    industry: "saas",
    type: "detailed-analysis",
    layout: "list",
    widgets: ["churn-risk-alert", "usage-trends", "support-tickets"],
    aggregation: "sum",
    default_time_range: "last_30_days",
    export_formats: ["pdf"],
    allow_branding: true,
    min_plan: "pro",
  },
];

/** Retail report templates. */
export const RetailReportTemplates: ReportTemplate[] = [
  {
    id: "retail-executive",
    name: "Executive Summary",
    industry: "retail",
    type: "executive-summary",
    layout: "grid",
    widgets: ["revenue-kpi", "aov-kpi", "conversion-kpi", "transactions-kpi", "sales-funnel"],
    aggregation: "sum",
    default_time_range: "last_30_days",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "pro",
  },
  {
    id: "retail-inventory",
    name: "Inventory Management",
    industry: "retail",
    type: "detailed-analysis",
    layout: "list",
    widgets: ["inventory-dashboard", "low-stock-alert", "product-performance"],
    aggregation: "sum",
    default_time_range: "custom",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "enterprise",
  },
  {
    id: "retail-conversion",
    name: "Conversion Rate Analysis",
    industry: "retail",
    type: "detailed-analysis",
    layout: "funnel",
    widgets: ["conversion-pipeline", "customer-journey", "abandoned-cart"],
    aggregation: "average",
    default_time_range: "last_30_days",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "pro",
  },
];

/** Manufacturing report templates. */
export const ManufacturingReportTemplates: ReportTemplate[] = [
  {
    id: "mfg-executive",
    name: "Executive Summary",
    industry: "manufacturing",
    type: "executive-summary",
    layout: "grid",
    widgets: ["oee-kpi", "defect-kpi", "lead-time-kpi", "throughput-kpi", "production-dashboard"],
    aggregation: "average",
    default_time_range: "last_30_days",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "pro",
  },
  {
    id: "mfg-quality",
    name: "Quality Report",
    industry: "manufacturing",
    type: "compliance-report",
    layout: "list",
    widgets: ["quality-issue-alert", "quality-trends", "first-pass-yield"],
    aggregation: "sum",
    default_time_range: "custom",
    export_formats: ["pdf"],
    allow_branding: false,
    compliance_watermark: true,
    min_plan: "enterprise",
  },
  {
    id: "mfg-oee",
    name: "OEE Analysis",
    industry: "manufacturing",
    type: "detailed-analysis",
    layout: "funnel",
    widgets: ["oee-breakdown", "downtime-analysis", "maintenance-schedule"],
    aggregation: "average",
    default_time_range: "last_90_days",
    export_formats: ["pdf", "excel"],
    allow_branding: true,
    min_plan: "pro",
  },
];

/** Get report templates for a specific industry. */
export function getIndustryReportTemplates(
  industry: Industry
): ReportTemplate[] {
  const templates: Record<Industry, ReportTemplate[]> = {
    finance: FinanceReportTemplates,
    saas: SaaSReportTemplates,
    retail: RetailReportTemplates,
    manufacturing: ManufacturingReportTemplates,
  };

  return templates[industry] || FinanceReportTemplates;
}

/** Get a specific report template by ID. */
export function getReportTemplate(
  industry: Industry,
  templateId: string
): ReportTemplate | undefined {
  const allTemplates = getIndustryReportTemplates(industry);
  return allTemplates.find((t) => t.id === templateId);
}

/** API route to get industry report templates. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";

    const templates = getIndustryReportTemplates(industry as Industry);

    return new Response(JSON.stringify(templates), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Industry report templates error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve report templates" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}