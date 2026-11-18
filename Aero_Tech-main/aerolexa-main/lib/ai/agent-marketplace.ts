/**
 * Phase 58: Vertical-Specific AI Agent Marketplace
 *
 * Marketplace for discovering, installing, and managing vertical-specific AI agents.
 * Features agent ratings, pricing tiers, trial installations, and integration
 * with the agent orchestration system (Phase 57). Supports free and commercial
 * agents with revenue sharing for agent creators.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import type { GovernanceFramework } from "@/lib/governance/audit-management";

import type { AgentType, Industry } from "./agent-orchestration";

export type AgentTier = "free" | "pro" | "enterprise" | "custom";

export interface AgentListing {
  id: string;
  name: string;
  description: string;
  industry: Industry;
  agent_type: AgentType;
  tier: AgentTier;
  // Pricing
  monthly_price: number; // 0 for free
  // Ratings
  avg_rating: number; // 1-5
  review_count: number;
  // Features
  capabilities: string[];
  is_active: boolean;
  // Trial info
  trial_available: boolean;
  trial_duration_days: number;
  // Installation
  install_endpoint: string;
  // Metadata
  created_at: Date;
  created_by: string; // agent creator ID
  // Compliance
  compliance_frameworks: GovernanceFramework[];
  // Version
  version: string;
}

/** Mock agent marketplace data. */
export const AgentMarketplace: AgentListing[] = [
  // Finance agents
  {
    id: "finance-research-1",
    name: "Finance Market Research Agent",
    description: "Research agent for financial markets, regulatory changes, and risk analysis",
    industry: "finance" as Industry,
    agent_type: "research" as AgentType,
    tier: "pro" as AgentTier,
    monthly_price: 99,
    avg_rating: 4.8,
    review_count: 34,
    capabilities: ["market_analysis", "trend_research", "regulatory_review"],
    is_active: true,
    trial_available: true,
    trial_duration_days: 14,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=research&industry=finance",
    created_at: new Date("2024-01-15"),
    created_by: "agent_creator_1",
    compliance_frameworks: ["SOC2", "GDPR"],
    version: "1.2.0",
  },
  {
    id: "finance-analysis-1",
    name: "Finance Analysis Agent",
    description: "Analysis agent for portfolio performance, ROI calculation, and risk scoring",
    industry: "finance" as Industry,
    agent_type: "analysis" as AgentType,
    tier: "enterprise" as AgentTier,
    monthly_price: 299,
    avg_rating: 4.9,
    review_count: 56,
    capabilities: ["portfolio_analysis", "roi_calculation", "risk_scoring"],
    is_active: true,
    trial_available: false,
    trial_duration_days: 0,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=analysis&industry=finance",
    created_at: new Date("2024-02-01"),
    created_by: "agent_creator_1",
    compliance_frameworks: ["SOC2", "PCI_DSS"],
    version: "2.1.0",
  },
  // SaaS agents
  {
    id: "saas-research-1",
    name: "SaaS Growth Research Agent",
    description: "Research agent for SaaS market sizing, competitor analysis, and growth opportunities",
    industry: "saas" as Industry,
    agent_type: "research" as AgentType,
    tier: "pro" as AgentTier,
    monthly_price: 79,
    avg_rating: 4.7,
    review_count: 28,
    capabilities: ["market_sizing", "competitor_analysis", "growth_opportunities"],
    is_active: true,
    trial_available: true,
    trial_duration_days: 14,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=research&industry=saas",
    created_at: new Date("2024-01-20"),
    created_by: "agent_creator_2",
    compliance_frameworks: ["SOC2", "GDPR"],
    version: "1.1.0",
  },
  {
    id: "saas-churn-1",
    name: "SaaS Churn Prevention Agent",
    description: "Execution agent for churn prevention, customer retention, and renewal workflows",
    industry: "saas" as Industry,
    agent_type: "execution" as AgentType,
    tier: "enterprise" as AgentTier,
    monthly_price: 199,
    avg_rating: 4.9,
    review_count: 44,
    capabilities: ["churn_analysis", "retention_workflows", "renewal_automation"],
    is_active: true,
    trial_available: false,
    trial_duration_days: 0,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=execution&industry=saas",
    created_at: new Date("2024-03-01"),
    created_by: "agent_creator_2",
    compliance_frameworks: ["SOC2"],
    version: "3.0.0",
  },
  // Retail agents
  {
    id: "retail-research-1",
    name: "Retail Market Research Agent",
    description: "Research agent for retail market trends, competitor pricing, and category insights",
    industry: "retail" as Industry,
    agent_type: "research" as AgentType,
    tier: "pro" as AgentTier,
    monthly_price: 89,
    avg_rating: 4.6,
    review_count: 22,
    capabilities: ["market_trends", "competitor_pricing", "category_insights"],
    is_active: true,
    trial_available: true,
    trial_duration_days: 14,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=research&industry=retail",
    created_at: new Date("2024-01-25"),
    created_by: "agent_creator_3",
    compliance_frameworks: ["PCI_DSS", "GDPR"],
    version: "1.3.0",
  },
  {
    id: "retail-optimization-1",
    name: "Retail Optimization Agent",
    description: "Analysis agent for conversion optimization, inventory management, and customer segmentation",
    industry: "retail" as Industry,
    agent_type: "analysis" as AgentType,
    tier: "pro" as AgentTier,
    monthly_price: 129,
    avg_rating: 4.8,
    review_count: 31,
    capabilities: ["conversion_optimization", "inventory_management", "customer_segmentation"],
    is_active: true,
    trial_available: true,
    trial_duration_days: 7,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=analysis&industry=retail",
    created_at: new Date("2024-02-15"),
    created_by: "agent_creator_3",
    compliance_frameworks: ["PCI_DSS"],
    version: "2.0.0",
  },
  // Manufacturing agents
  {
    id: "mfg-research-1",
    name: "Manufacturing OEE Agent",
    description: "Research agent for OEE benchmarks, downtime analysis, and quality trend analysis",
    industry: "manufacturing" as Industry,
    agent_type: "research" as AgentType,
    tier: "pro" as AgentTier,
    monthly_price: 119,
    avg_rating: 4.7,
    review_count: 18,
    capabilities: ["oee_benchmarks", "downtime_analysis", "quality_trends"],
    is_active: true,
    trial_available: true,
    trial_duration_days: 14,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=research&industry=manufacturing",
    created_at: new Date("2024-01-30"),
    created_by: "agent_creator_4",
    compliance_frameworks: ["ISO_9001", "SOC2"],
    version: "1.0.0",
  },
  {
    id: "mfg-maintenance-1",
    name: "Manufacturing Maintenance Agent",
    description: "Execution agent for predictive maintenance, scheduling, and equipment optimization",
    industry: "manufacturing" as Industry,
    agent_type: "execution" as AgentType,
    tier: "enterprise" as AgentTier,
    monthly_price: 249,
    avg_rating: 4.9,
    review_count: 41,
    capabilities: ["predictive_maintenance", "maintenance_scheduling", "equipment_optimization"],
    is_active: true,
    trial_available: false,
    trial_duration_days: 0,
    install_endpoint: "/api/ai/agent-orchestration?agent_types=execution&industry=manufacturing",
    created_at: new Date("2024-03-15"),
    created_by: "agent_creator_4",
    compliance_frameworks: ["SOC2"],
    version: "2.3.0",
  },
];

/** Get agent listings for a specific industry. */
export function getAgentsByIndustry(
  industry: Industry
): AgentListing[] {
  return AgentMarketplace.filter((agent) => agent.industry === industry);
}

/** Get a specific agent by ID. */
export function getAgentById(
  agentId: string
): AgentListing | undefined {
  return AgentMarketplace.find((agent) => agent.id === agentId);
}

/** Get free agents across all industries. */
export function getFreeAgents(): AgentListing[] {
  return AgentMarketplace.filter((agent) => agent.tier === "free" as AgentTier);
}

/** Get agent tiers with pricing info. */
export function getAgentTiers(): Record<AgentTier, {
  min_price: number;
  max_price: number;
  description: string;
}> {
  return {
    free: { min_price: 0, max_price: 0, description: "Free agents (community edition)" },
    pro: { min_price: 50, max_price: 199, description: "Professional agents for growing businesses" },
    enterprise: { min_price: 200, max_price: 499, description: "Enterprise agents for large organizations" },
    custom: { min_price: 500, max_price: 500, description: "Custom agents with tailored capabilities" },
  };
}

/** API route for agent marketplace. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "list";

    if (action === "list") {
      const industry = searchParams.get("industry") as Industry || "saas";

      const agents = industry
        ? getAgentsByIndustry(industry)
        : AgentMarketplace;

      return new Response(JSON.stringify({ industry, agents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "by-id") {
      const agentId = searchParams.get("agent_id") || "";

      const agent = getAgentById(agentId);

      return new Response(JSON.stringify({ agent }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "tiers") {
      const tiers = getAgentTiers();

      return new Response(JSON.stringify({ tiers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "free") {
      const freeAgents = getFreeAgents();

      return new Response(JSON.stringify({ freeAgents }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list all agents
    return new Response(JSON.stringify({ agents: AgentMarketplace }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Agent marketplace error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve agent marketplace data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/** Purchase/install an agent. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const {
      agent_id,
      user_id,
      industry,
      tier,
    } = body;

    const agent = getAgentById(agent_id);

    if (!agent) {
      return new Response(
        JSON.stringify({ error: "Agent not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!agent.trial_available && tier === "trial") {
      return new Response(
        JSON.stringify({ error: "Trials not available for this agent" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // In a real implementation, this would:
    // 1. Record the purchase/installation
    // 2. Charge the appropriate amount (if not trial)
    // 3. Activate the agent for the user
    // 4. Return installation credentials

    const installation: {
      agent_id: string;
      user_id: string;
      industry: Industry;
      tier: AgentTier;
      installed_at: Date;
      expires_at?: Date;
      credentials: Record<string, string>;
    } = {
      agent_id: agent.id,
      user_id: user_id || "user_1",
      industry: agent.industry,
      tier: tier || agent.tier,
      installed_at: new Date(),
      credentials: {
        agent_endpoint: agent.install_endpoint,
        agent_name: agent.name,
        agent_type: agent.agent_type,
      },
    };

    // Set expiration for trials
    if (agent.trial_available && (tier === "trial" || agent.tier === "free")) {
      installation.expires_at = new Date(Date.now() + (agent.trial_duration_days || 14) * 24 * 60 * 60 * 1000);
    }

    return new Response(JSON.stringify(installation), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Agent purchase error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to purchase/install agent" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}