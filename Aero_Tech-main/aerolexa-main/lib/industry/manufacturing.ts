/**
 * Phase 36: Manufacturing Industry Template
 *
 * Pre-built metrics, KPIs, and compliance mappings for Manufacturing.
 * Focuses on operational efficiency, quality, downtime, and productivity.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export interface ManufacturingKPI {
  id: string;
  name: string;
  label: string;
  type: "ratio" | "percentage" | "currency" | "count" | "time";
  aggregation: "sum" | "average" | "count" | "min" | "max";
  decimals: number;
  critical: boolean;
}

/** Manufacturing industry template - pre-configured for manufacturing. */
export const ManufacturingTemplate = {
  id: "manufacturing",
  name: "Manufacturing",
  description: "Manufacturing plants and production facilities analytics",

  kpis: [
    // Operational efficiency KPIs
    {
      id: "overall_equipment_effectiveness",
      name: "Overall Equipment Effectiveness",
      label: "OEE %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "downtime_hours",
      name: "Downtime Hours",
      label: "Downtime Hours",
      type: "count",
      aggregation: "sum",
      decimals: 2,
      critical: true,
    },
    {
      id: "throughput_units",
      name: "Throughput Units",
      label: "Units/Hour",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Quality KPIs
    {
      id: "first_pass_yield",
      name: "First Pass Yield",
      label: "FPY %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "defect_rate",
      name: "Defect Rate",
      label: "Defect Rate %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "rework_rate",
      name: "Rework Rate",
      label: "Rework Rate %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Productivity KPIs
    {
      id: "labor_productivity",
      name: "Labor Productivity",
      label: "Units/Labor Hour",
      type: "ratio",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "overtime_hours",
      name: "Overtime Hours",
      label: "Overtime Hours",
      type: "count",
      aggregation: "sum",
      decimals: 2,
      critical: false,
    },
    // Quality costs
    {
      id: "cost_of_quality",
      name: "Cost of Quality",
      label: "Cost of Quality $",
      type: "currency",
      aggregation: "sum",
      decimals: 2,
      critical: true,
    },
    {
      id: "waste_percentage",
      name: "Waste Percentage",
      label: "Waste %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Delivery KPIs
    {
      id: "on_time_delivery",
      name: "On-Time Delivery",
      label: "On-Time Delivery %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "order_lead_time",
      name: "Order Lead Time",
      label: "Lead Time Days",
      type: "time",
      aggregation: "average",
      decimals: 1,
      critical: true,
    },
    // Inventory KPIs
    {
      id: "inventory_turns",
      name: "Inventory Turns",
      label: "Inventory Turns",
      type: "ratio",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "stock_to_sales_ratio",
      name: "Stock-to-Sales Ratio",
      label: "Stock-to-Sales",
      type: "ratio",
      aggregation: "average",
      decimals: 2,
      critical: false,
    },
  ],

  defaultCharts: [
    "production-dashboard",
    "quality-trends",
    "downtime-analysis",
    "OEE-waterfall",
    "delivery-performance",
  ],

  compliance: {
    hipaa: false,
    soc2: true, // Manufacturing may pursue SOC2 for enterprise clients
    pci_dss: false, // Typically not applicable unless hardware payments
    gdpr: true, // If serving EU customers or using data globally
    customRequirements: ["ISO 9001", "IATF 16949"],
  },

  retentionDays: 1825, // 5 years (typical manufacturing record retention)
  enabledFeatures: [
    "advanced-charts",
    "pdf-export",
    "api-access",
    "custom-branding",
    "audit-logging",
    "maintenance-tracking",
    "quality-management",
  ],

  theme: {
    primary: "#16a34a", // Green-600 - production/health
    secondary: "#3b82f6", // Blue-500 - reliability/tech
    accent: "#f59e0b", // Amber-500 - warnings/attention
  },
};

/** Get the active industry template. */
export function getIndustryTemplate(industry: string): any {
  const templates: Record<string, any> = {
    manufacturing: ManufacturingTemplate,
    retail: await import("./retail").then((m) => m.RetailTemplate),
    saas: await import("./saas").then((m) => m.SaaSTemplate),
    finance: await import("./finance").then((m) => m.FinanceTemplate),
  };

  return templates[industry] || ManufacturingTemplate;
}

/** API route to get industry template. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "manufacturing";

    const template = getIndustryTemplate(industry);

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