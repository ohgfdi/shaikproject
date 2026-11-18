/**
 * Phase 39: Industry-Specific Dashboard Configurations
 *
 * Pre-built dashboard layouts and widget configurations optimized for each industry vertical.
 * Integrates with the industry templates (Phases 33-36) and compliance mappings (Phase 37).
 */
import type { NextRequest } from "next/server";
import React from "react";

import { prisma } from "@/lib/db";
import { getIndustryTemplate, getComplianceRequirements } from "@/lib/industry";
import type { Industry } from "@/lib/industry/finance";

export type DashboardLayout = "finance" | "saas" | "retail" | "manufacturing";

export interface DashboardWidgetConfig {
  id: string;
  type: "kpi" | "chart" | "table" | "status" | "progress";
  position: { x: number; y: number; w: number; h: number };
  title: string;
  // Configuration specific to widget type
  config?: Record<string, any>;
  // Linked KPI or data source
  kpiId?: string;
  chartSpecId?: string;
  // Visibility per role/plan
  visibleRoles: string[];
  // Per-industry customization
  industryOverride?: Industry;
}

export interface IndustryDashboardConfig {
  id: string;
  name: string;
  layout: DashboardLayout;
  description: string;
  // Default widgets arranged in a grid
  defaultWidgets: DashboardWidgetConfig[];
  // Grid settings
  gridX: number; // max columns
  gridY: number; // max rows
  // Spacing
  widgetSpacing: number;
  // Auto-refresh settings
  autoRefresh?: number; // minutes
  // Compliance settings
  compliance: {
    enabled: boolean;
    frameworks: string[];
    retentionDays: number;
  };
}

/** Finance dashboard configuration - optimized for financial services. */
export const FinanceDashboardConfig: IndustryDashboardConfig = {
  id: "finance",
  name: "Financial Services Dashboard",
  layout: "finance",
  description: "Pre-configured dashboard for financial KPIs and compliance reporting",

  defaultWidgets: [
    // KPI Row - Top row with critical metrics
    {
      id: "roi-kpi",
      type: "kpi",
      position: { x: 0, y: 0, w: 2, h: 1 },
      title: "ROI %",
      kpiId: "roi",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "arr-kpi",
      type: "kpi",
      position: { x: 2, y: 0, w: 2, h: 1 },
      title: "ARR $",
      kpiId: "arr",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "cac-kpi",
      type: "kpi",
      position: { x: 4, y: 0, w: 2, h: 1 },
      title: "CAC $",
      kpiId: "cac",
      visibleRoles: ["admin", "analyst"],
    },
    {
      id: "churn-kpi",
      type: "kpi",
      position: { x: 6, y: 0, w: 2, h: 1 },
      title: "Churn %",
      kpiId: "churn",
      visibleRoles: ["admin", "analyst"],
    },

    // Charts - Main analysis area
    {
      id: "revenue-funnel",
      type: "chart",
      position: { x: 0, y: 1, w: 6, h: 3 },
      title: "Revenue Funnel",
      chartSpecId: "revenue-waterfall",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "risk-dashboard",
      type: "chart",
      position: { x: 6, y: 1, w: 3, h: 3 },
      title: "Risk Dashboard",
      chartSpecId: "risk-dashboard",
      visibleRoles: ["admin", "executive"],
    },

    // Compliance panel
    {
      id: "compliance-status",
      type: "status",
      position: { x: 0, y: 4, w: 3, h: 1 },
      title: "Compliance Status",
      config: { frameworks: ["SOC2", "GDPR"], showDetails: true },
      visibleRoles: ["admin", "executive"],
    },

    // Activity feed
    {
      id: "recent-activity",
      type: "table",
      position: { x: 3, y: 4, w: 4, h: 1 },
      title: "Recent Activity",
      visibleRoles: ["admin", "analyst", "executive"],
    },
  ],

  gridX: 10,
  gridY: 6,
  widgetSpacing: 8,
  autoRefresh: 5,
  compliance: {
    enabled: true,
    frameworks: ["SOC2", "GDPR", "PCI_DSS"],
    retentionDays: 2555,
  },
};

/** SaaS dashboard configuration - optimized for SaaS businesses. */
export const SaaSDashboardConfig: IndustryDashboardConfig = {
  id: "saas",
  name: "SaaS Dashboard",
  layout: "saas",
  description: "Pre-configured dashboard for SaaS metrics and growth tracking",

  defaultWidgets: [
    // KPI Row - Top row with critical metrics
    {
      id: "mrr-kpi",
      type: "kpi",
      position: { x: 0, y: 0, w: 2, h: 1 },
      title: "MRR $",
      kpiId: "mrr",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "arr-kpi",
      type: "kpi",
      position: { x: 2, y: 0, w: 2, h: 1 },
      title: "ARR $",
      kpiId: "arr",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "nrr-kpi",
      type: "kpi",
      position: { x: 4, y: 0, w: 2, h: 1 },
      title: "NRR %",
      kpiId: "net_revenue_retention",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "dau-kpi",
      type: "kpi",
      position: { x: 6, y: 0, w: 2, h: 1 },
      title: "DAU",
      kpiId: "daily_active_users",
      visibleRoles: ["admin", "analyst"],
    },

    // Charts - Main analysis area
    {
      id: "funnel-analysis",
      type: "chart",
      position: { x: 0, y: 1, w: 7, h: 4 },
      title: "Funnel Analysis",
      chartSpecId: "funnel-analysis",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "cohort-analysis",
      type: "chart",
      position: { x: 7, y: 1, w: 4, h: 4 },
      title: "Cohort Analysis",
      chartSpecId: "cohort-analysis",
      visibleRoles: ["admin", "analyst"],
    },

    // Retention grid
    {
      id: "retention-grid",
      type: "chart",
      position: { x: 0, y: 5, w: 5, h: 2 },
      title: "Retention Grid",
      chartSpecId: "retention-grid",
      visibleRoles: ["admin", "analyst", "executive"],
    },

    // Customer metrics
    {
      id: "activation-dashboard",
      type: "chart",
      position: { x: 5, y: 5, w: 6, h: 2 },
      title: "Activation Dashboard",
      chartSpecId: "activation-dashboard",
      visibleRoles: ["admin", "analyst"],
    },
  ],

  gridX: 12,
  gridY: 7,
  widgetSpacing: 8,
  autoRefresh: 3,
  compliance: {
    enabled: true,
    frameworks: ["SOC2", "GDPR"],
    retentionDays: 1095,
  },
};

/** Retail dashboard configuration - optimized for retail/e-commerce. */
export const RetailDashboardConfig: IndustryDashboardConfig = {
  id: "retail",
  name: "Retail Dashboard",
  layout: "retail",
  description: "Pre-configured dashboard for retail sales and performance",

  defaultWidgets: [
    // KPI Row - Top row with critical metrics
    {
      id: "revenue-kpi",
      type: "kpi",
      position: { x: 0, y: 0, w: 2, h: 1 },
      title: "Revenue $",
      kpiId: "total_revenue",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "aov-kpi",
      type: "kpi",
      position: { x: 2, y: 0, w: 2, h: 1 },
      title: "AOV $",
      kpiId: "average_order_value",
      visibleRoles: ["admin", "analyst"],
    },
    {
      id: "conversion-kpi",
      type: "kpi",
      position: { x: 4, y: 0, w: 2, h: 1 },
      title: "Conversion %",
      kpiId: "conversion_rate",
      visibleRoles: ["admin", "analyst"],
    },
    {
      id: "transactions-kpi",
      type: "kpi",
      position: { x: 6, y: 0, w: 2, h: 1 },
      title: "Transactions",
      kpiId: "total_transactions",
      visibleRoles: ["admin", "analyst"],
    },

    // Charts - Main analysis area
    {
      id: "sales-funnel",
      type: "chart",
      position: { x: 0, y: 1, w: 8, h: 4 },
      title: "Sales Funnel",
      chartSpecId: "sales-funnel",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "conversion-pipeline",
      type: "chart",
      position: { x: 8, y: 1, w: 5, h: 4 },
      title: "Conversion Pipeline",
      chartSpecId: "conversion-pipeline",
      visibleRoles: ["admin", "analyst"],
    },

    // Inventory panel
    {
      id: "inventory-dashboard",
      type: "chart",
      position: { x: 0, y: 5, w: 6, h: 3 },
      title: "Inventory Dashboard",
      chartSpecId: "inventory-dashboard",
      visibleRoles: ["admin", "analyst"],
    },

    // Customer behavior
    {
      id: "customer-journey",
      type: "chart",
      position: { x: 6, y: 5, w: 5, h: 3 },
      title: "Customer Journey",
      chartSpecId: "customer-journey",
      visibleRoles: ["admin", "analyst"],
    },
  ],

  gridX: 12,
  gridY: 7,
  widgetSpacing: 8,
  autoRefresh: 5,
  compliance: {
    enabled: true,
    frameworks: ["PCI_DSS", "GDPR"],
    retentionDays: 365,
  },
};

/** Manufacturing dashboard configuration - optimized for manufacturing. */
export const ManufacturingDashboardConfig: IndustryDashboardConfig = {
  id: "manufacturing",
  name: "Manufacturing Dashboard",
  layout: "manufacturing",
  description: "Pre-configured dashboard for operational efficiency and quality",

  defaultWidgets: [
    // KPI Row - Top row with critical metrics
    {
      id: "oee-kpi",
      type: "kpi",
      position: { x: 0, y: 0, w: 2, h: 1 },
      title: "OEE %",
      kpiId: "overall_equipment_effectiveness",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "defect-kpi",
      type: "kpi",
      position: { x: 2, y: 0, w: 2, h: 1 },
      title: "Defect Rate %",
      kpiId: "defect_rate",
      visibleRoles: ["admin", "analyst"],
    },
    {
      id: "lead-time-kpi",
      type: "kpi",
      position: { x: 4, y: 0, w: 2, h: 1 },
      title: "Lead Time Days",
      kpiId: "order_lead_time",
      visibleRoles: ["admin", "analyst"],
    },
    {
      id: "throughput-kpi",
      type: "kpi",
      position: { x: 6, y: 0, w: 2, h: 1 },
      title: "Throughput",
      kpiId: "throughput_units",
      visibleRoles: ["admin", "analyst"],
    },

    // Charts - Main analysis area
    {
      id: "production-dashboard",
      type: "chart",
      position: { x: 0, y: 1, w: 8, h: 4 },
      title: "Production Dashboard",
      chartSpecId: "production-dashboard",
      visibleRoles: ["admin", "analyst", "executive"],
    },
    {
      id: "quality-trends",
      type: "chart",
      position: { x: 8, y: 1, w: 5, h: 4 },
      title: "Quality Trends",
      chartSpecId: "quality-trends",
      visibleRoles: ["admin", "analyst"],
    },

    // Downtime analysis
    {
      id: "downtime-analysis",
      type: "chart",
      position: { x: 0, y: 5, w: 6, h: 3 },
      title: "Downtime Analysis",
      chartSpecId: "downtime-analysis",
      visibleRoles: ["admin", "analyst"],
    },

    // OEE breakdown
    {
      id: "oee-breakdown",
      type: "chart",
      position: { x: 6, y: 5, w: 7, h: 2 },
      title: "OEE Breakdown",
      chartSpecId: "OEE-waterfall",
      visibleRoles: ["admin", "analyst", "executive"],
    },
  ],

  gridX: 12,
  gridY: 7,
  widgetSpacing: 8,
  autoRefresh: 2, // Manufacturing: more frequent updates
  compliance: {
    enabled: true,
    frameworks: ["SOC2", "ISO 9001"],
    retentionDays: 1825,
  },
};

/** Get the active industry dashboard config. */
export function getIndustryDashboardConfig(
  industry: DashboardLayout
): IndustryDashboardConfig {
  const configs: Record<DashboardLayout, IndustryDashboardConfig> = {
    finance: FinanceDashboardConfig,
    saas: SaaSDashboardConfig,
    retail: RetailDashboardConfig,
    manufacturing: ManufacturingDashboardConfig,
  };

  return configs[industry] || FinanceDashboardConfig;
}

/** API route to get industry dashboard config. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";

    const config = getIndustryDashboardConfig(industry as DashboardLayout);

    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Industry dashboard config error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve dashboard configuration" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}