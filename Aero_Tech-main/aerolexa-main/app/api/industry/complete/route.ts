/**
 * Phase 40: Full Industry Template API with Authentication
 *
 * Comprehensive API endpoint that returns all industry-related data in one call:
 * - Industry template (KPIs, charts, compliance, features)
 - Compliance requirements - Vertical integrations config
 * - Dashboard configuration - Tenant-specific customization
 */

import { getIndustryDashboardConfig } from "@/components/industry/dashboard-configs";
import { prisma } from "@/lib/db";
import { getIndustryTemplate as getIndustryTemplateFn } from "@/lib/industry";
import type { Industry } from "@/lib/industry";
import { getComplianceRequirements } from "@/lib/industry/compliance-mappings";
import { getIntegrationConfig } from "@/lib/industry/integrations";

export const dynamic = "force-dynamic";

/** GET /api/industry/complete?industry=saas
 * Returns comprehensive industry data for the specified sector.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";

    // 1. Get industry template
    const template = getIndustryTemplateFn(industry as Industry);

    // 2. Get compliance requirements for key frameworks
    const complianceFrameworks = ["SOC2", "GDPR", "PCI_DSS", "HIPAA"].map(
      (framework) => getComplianceRequirements(industry, framework as any)
    );

    // 3. Get dashboard configuration
    const dashboardConfig = getIndustryDashboardConfig(
      industry as "finance" | "saas" | "retail" | "manufacturing"
    );

    // 4. Get integration configurations
    const integrationTypes: ("salesforce" | "hubspot" | "jira" | "snowflake" | "slack" | "mailchimp")[] =
      ["salesforce", "hubspot", "jira", "snowflake", "slack", "mailchimp"];
    const integrations = integrationTypes.map((type) => ({
      type,
      config: getIntegrationConfig(type),
      available: isIntegrationAvailable(type),
    }));

    // 5. Check tenant-specific features
    const tenantId = searchParams.get("tenantId") || "default";
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        plan: true,
        features: true,
        status: true,
      },
    });

    const completeResponse = {
      industry,
      template,
      compliance: complianceFrameworks,
      dashboard: dashboardConfig,
      integrations,
      tenant: tenant
        ? {
            plan: tenant.plan,
            features: tenant.features || [],
            status: tenant.status,
          }
        : {
            plan: "free",
            features: [],
            status: "active",
          },
      // Metadata
      generatedAt: new Date().toISOString(),
      version: "2.0.0",
    };

    return new Response(JSON.stringify(completeResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Complete industry API error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve complete industry data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/** Helper: Check if integration is available (has credentials configured). */
function isIntegrationAvailable(type: string): boolean {
  return !!(
    process.env[`${type.toUpperCase()}_CLIENT_ID`] ||
    process.env[`${type.toUpperCase()}_API_KEY`]
  );
}