/**
 * Phase 35: Retail Industry Template
 *
 * Pre-built metrics, KPIs, and compliance mappings for Retail/E-commerce.
 * Focuses on sales performance, conversion, inventory, and customer behavior.
 */
import type { NextRequest } from "next/server";


export interface RetailKPI {
  id: string;
  name: string;
  label: string;
  type: "ratio" | "percentage" | "currency" | "count" | "time";
  aggregation: "sum" | "average" | "count" | "min" | "max";
  decimals: number;
  critical: boolean;
}

/** Retail industry template - pre-configured for retail/e-commerce. */
export const RetailTemplate = {
  id: "retail",
  name: "Retail & E-commerce",
  description: "Retail stores and e-commerce businesses analytics",

  kpis: [
    // Sales metrics
    {
      id: "total_revenue",
      name: "Total Revenue",
      label: "Revenue $",
      type: "currency",
      aggregation: "sum",
      decimals: 0,
      critical: true,
    },
    {
      id: "average_order_value",
      name: "Average Order Value",
      label: "AOV $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "conversion_rate",
      name: "Conversion Rate",
      label: "Conversion %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "total_transactions",
      name: "Total Transactions",
      label: "Transactions",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    // Traffic metrics
    {
      id: "total_visitors",
      name: "Total Visitors",
      label: "Visitors",
      type: "count",
      aggregation: "count",
      decimals: 0,
      critical: true,
    },
    {
      id: "bounce_rate",
      name: "Bounce Rate",
      label: "Bounce Rate %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Inventory metrics
    {
      id: "inventory_turnover",
      name: "Inventory Turnover",
      label: "Inventory Turns",
      type: "ratio",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "out_of_stock_rate",
      name: "Out of Stock Rate",
      label: "Out of Stock %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    // Customer metrics
    {
      id: "customer_acquisition_cost",
      name: "Customer Acquisition Cost",
      label: "CAC $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "customer_lifetime_value",
      name: "Customer Lifetime Value",
      label: "LTV $",
      type: "currency",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "repeat_purchase_rate",
      name: "Repeat Purchase Rate",
      label: "Repeat Purchase %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: false,
    },
    // Profitability
    {
      id: "gross_margin_retail",
      name: "Gross Margin",
      label: "Gross Margin %",
      type: "percentage",
      aggregation: "average",
      decimals: 2,
      critical: true,
    },
    {
      id: "net_profit",
      name: "Net Profit",
      label: "Net Profit $",
      type: "currency",
      aggregation: "sum",
      decimals: 0,
      critical: true,
    },
  ],

  defaultCharts: [
    "sales-funnel",
    "conversion-pipeline",
    "inventory-dashboard",
    "customer-journey",
    "product-performance",
  ],

  compliance: {
    hipaa: false,
    soc2: false, // Retail typically doesn't pursue SOC2 unless enterprise
    pci_dss: true, // Critical for card data handling
    gdpr: true, // If serving EU customers
    customRequirements: ["CCPA"],
  },

  retentionDays: 365, // 1 year (typical retail seasonality)
  enabledFeatures: [
    "advanced-charts",
    "pdf-export",
    "api-access",
    "custom-branding",
    "audit-logging",
    "inventory-tracking",
    "order-management",
  ],

  theme: {
    primary: "#dc2626", // Red-600 - urgency/sales
    secondary: "#059669", // Emerald-600 - growth/health
    accent: "#eab308", // Amber-500 - attention/highlight
  },
};

/** Get the active industry template. */
export async function getIndustryTemplate(industry: string): Promise<any> {
  const templates: Record<string, any> = {
    retail: RetailTemplate,
    saas: await import("./saas").then((m) => m.SaaSTemplate),
    finance: await import("./finance").then((m) => m.FinanceTemplate),
  };

  return templates[industry] || RetailTemplate;
}

/** API route to get industry template. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "retail";

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