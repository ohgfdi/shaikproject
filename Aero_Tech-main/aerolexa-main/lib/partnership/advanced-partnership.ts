/**
 * Phase 49: Advanced Partnership Program with Co-Selling and Deal Registration
 *
 * Enhanced partner program with deal registration, co-selling workflows,
 * partner pipeline management, and revenue share tracking across all tiers.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import type { Industry } from "@/lib/industry";

export type PartnershipTier = "startup" | "growth" | "enterprise" | "strategic";

export interface PartnerDeal {
  id: string;
  partner_id: string;
  customer_name: string;
  industry: Industry;
  deal_value: number;
  deal_stage: "lead" | "qualified" | "proposal" | "negotiation" | "closed_lost" | "closed_won";
  deal_stage_description: string;
  referral_code: string;
  registered_at: Date;
  updated_at: Date;
  closed_at?: Date;
  // Revenue share tracking
  revenue_share_percent: number;
  revenue_share_credited: number;
  // Co-selling status
  co_selling: false | "partner_led" | "company_led" | "joint";
  // Activities
  activities: PartnerDealActivity[];
}

export interface PartnerDealActivity {
  id: string;
  type: "call" | "email" | "meeting" | "demo" | "proposal" | "follow_up";
  description: string;
  timestamp: Date;
  participant: "partner" | "company" | "customer";
  notes?: string;
}

/** Enhanced partner with deal pipeline. */
export interface EnhancedPartner {
  id: string;
  name: string;
  email: string;
  tier: PartnershipTier;
  onboarding_date: Date;
  status: "active" | "inactive" | "suspended";
  revenue_share_percent: number;
  referral_code: string;
  referrals_made: number;
  referrals_converted: number;
  // Deal pipeline
  pipeline_deals: PartnerDeal[];
  // Benefits
  benefits: string[];
  // Integration status
  integrations_built: number;
  integrations_certified: number;
  // Co-selling enablement
  co_selling_enabled: boolean;
  joint_marketing_fund_access: number; // dollars available per year
}

/** Partnership tier configurations with enhanced benefits. */
export const PartnershipTierConfigs: Record<PartnershipTier, {
  min_revenue: number;
  revenue_share_percent: number;
  benefits: string[];
  min_deal_size: number;
  co_selling_enabled: boolean;
  joint_marketing_fund: number; // annual fund in USD
  deal_registration_required: boolean;
}> = {
  startup: {
    min_revenue: 0,
    revenue_share_percent: 15,
    benefits: [
      "Standard revenue share (15%)",
      "Email support",
      "Partner portal access",
      "Marketing co-op funds ($500/year)",
      "Self-serve onboarding",
    ],
    min_deal_size: 1000,
    co_selling_enabled: false,
    joint_marketing_fund: 500,
    deal_registration_required: false,
  },
  growth: {
    min_revenue: 10000,
    revenue_share_percent: 20,
    benefits: [
      "Enhanced revenue share (20%)",
      "Priority email support",
      "Partner portal access",
      "Marketing co-op funds ($2,000/year)",
      "Co-selling opportunities",
      "Technical enablement workshops",
    ],
    min_deal_size: 5000,
    co_selling_enabled: true,
    joint_marketing_fund: 2000,
    deal_registration_required: true,
  },
  enterprise: {
    min_revenue: 50000,
    revenue_share_percent: 25,
    benefits: [
      "Premium revenue share (25%)",
      "Dedicated account manager",
      "Partner portal access",
      "Marketing co-op funds ($10,000/year)",
      "Co-selling with sales team",
      "Technical enablement + custom integration",
      "Priority product roadmap input",
    ],
    min_deal_size: 15000,
    co_selling_enabled: true,
    joint_marketing_fund: 10000,
    deal_registration_required: true,
  },
  strategic: {
    min_revenue: 200000,
    revenue_share_percent: 30,
    benefits: [
      "Revenue share (30%) + bonus pool",
      "Dedicated executive sponsor",
      "Custom partner portal",
      "Joint marketing development fund ($50,000/year)",
      "Co-selling with executive sponsorship",
      "Custom product development",
      "Priority engineering support",
      "Revenue guarantee program",
    ],
    min_deal_size: 50000,
    co_selling_enabled: true,
    joint_marketing_fund: 50000,
    deal_registration_required: true,
  },
};

/** Get partnership tier configuration. */
export function getPartnershipTierConfig(
  tier: PartnershipTier
): {
  min_revenue: number;
  revenue_share_percent: number;
  benefits: string[];
  min_deal_size: number;
  co_selling_enabled: boolean;
  joint_marketing_fund: number;
  deal_registration_required: boolean;
} {
  return PartnershipTierConfigs[tier] || PartnershipTierConfigs.growth;
}

/** Register a new deal. */
export async function registerDeal(
  partnerId: string,
  customerName: string,
  industry: Industry,
  dealValue: number,
  dealStage: "lead" | "qualified" | "proposal" | "negotiation" | "closed_lost" | "closed_won",
  referralCode: string
): Promise<PartnerDeal> {
  const deal: PartnerDeal = {
    id: Date.now().toString(),
    partner_id: partnerId,
    customer_name: customerName,
    industry,
    deal_value: dealValue,
    deal_stage: dealStage,
    deal_stage_description: getDealStageDescription(dealStage),
    referral_code: referralCode,
    registered_at: new Date(),
    updated_at: new Date(),
    closed_at: dealStage === "closed_won" ? new Date() : undefined,
    revenue_share_percent: 20, // Would look up partner tier
    revenue_share_credited: dealStage === "closed_won" ? Math.round(dealValue * 0.2) : 0,
    co_selling: dealStage === "lead" ? false : "joint", // Co-selling enabled for non-lead stages
    activities: [],
  };

  return deal;
}

/** Add activity to a deal. */
export function addDealActivity(
  dealId: string,
  activity: PartnerDealActivity
): PartnerDealActivity {
  return activity;
}

/** Get deal stage description. */
function getDealStageDescription(stage: string): string {
  const descriptions: Record<string, string> = {
    lead: "Initial contact made, qualifying begin",
    qualified: "Lead qualified, needs assessment starting",
    proposal: "Proposal submitted, negotiation beginning",
    negotiation: "Terms being negotiated, legal review",
    closed_lost: "Deal lost to competitor or no decision",
    closed_won: "Deal won, contract signing pending",
  };
  return descriptions[stage] || "";
}

/** API route for advanced partnership endpoints. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "list";

    if (action === "tier-config") {
      const tier = searchParams.get("tier") as PartnershipTier || "growth";
      const config = getPartnershipTierConfig(tier);

      return new Response(JSON.stringify({ tier, config }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "deal") {
      const partnerId = searchParams.get("partner_id") || "partner_1";
      // In real implementation, fetch from DB
      const deals: PartnerDeal[] = [];

      return new Response(JSON.stringify({ deals }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list enhanced partners
    const partners: EnhancedPartner[] = [
      {
        id: "partner_1",
        name: "Acme FinTech",
        email: "partners@acme-fintech.com",
        tier: "enterprise",
        onboarding_date: new Date("2024-01-15"),
        status: "active",
        revenue_share_percent: 25,
        referral_code: "ACME2024",
        referrals_made: 12,
        referrals_converted: 5,
        pipeline_deals: [
          {
            id: "deal_1",
            partner_id: "partner_1",
            customer_name: "Enterprise Bank Corp",
            industry: "finance",
            deal_value: 75000,
            deal_stage: "negotiation",
            deal_stage_description: "Terms being negotiated, legal review",
            referral_code: "ACME2024",
            registered_at: new Date("2024-06-01"),
            updated_at: new Date("2024-06-15"),
            closed_at: undefined,
            revenue_share_percent: 25,
            revenue_share_credited: 18750,
            co_selling: "joint",
            activities: [
              {
                id: "act_1",
                type: "call",
                description: "Initial discovery call with CFO",
                timestamp: new Date("2024-06-01"),
                participant: "partner",
              },
              {
                id: "act_2",
                type: "demo",
                description: "Product demonstration for leadership team",
                timestamp: new Date("2024-06-10"),
                participant: "company",
              },
            ],
          },
        ],
        benefits: [
          "Dedicated account manager",
          "Partner portal access",
          "Marketing co-op funds ($10,000/year)",
          "Co-selling with sales team",
          "Technical enablement + custom integration",
        ],
        integrations_built: 8,
        integrations_certified: 5,
        co_selling_enabled: true,
        joint_marketing_fund_access: 10000,
      },
    ];

    return new Response(JSON.stringify({ partners }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Advanced partnership error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve partnership data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/** POST /api/partnership/advanced/register-deal
 * Register a new deal for revenue sharing.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const {
      partner_id,
      customer_name,
      industry,
      deal_value,
      deal_stage,
      referral_code,
    } = body;

    const deal = await registerDeal(
      partner_id,
      customer_name,
      industry,
      deal_value,
      deal_stage,
      referral_code
    );

    return new Response(JSON.stringify(deal), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Register deal error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to register deal" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}