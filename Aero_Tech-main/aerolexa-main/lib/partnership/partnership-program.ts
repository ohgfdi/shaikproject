/**
 * Phase 44: Partnership/ISV Program with Revenue Sharing
 *
 * Partner program management for ISVs (Independent Software Vendors),
 * OEM partners, and system integrators. Includes tiered partnerships,
 * revenue sharing, and referral tracking.
 */
import type { NextRequest } from "next/server";


export type PartnershipTier = "startup" | "growth" | "enterprise" | "strategic";

export interface Partner {
  id: string;
  name: string;
  email: string;
  tier: PartnershipTier;
  // Partnership details
  onboarding_date: Date;
  status: "active" | "inactive" | "suspended";
  // Revenue sharing
  revenue_share_percent: number;
  // Referral tracking
  referral_code: string;
  referrals_made: number;
  referrals_converted: number;
  // Benefits
  benefits: string[];
  // Contact info
  assigned_account_manager?: string;
  // Integration status
  integrations_built: number;
  integrations_certified: number;
}

/** Partnership tier definitions with revenue share percentages. */
export const PartnershipTiers: Record<PartnershipTier, {
  min_revenue: number;
  revenue_share_percent: number;
  benefits: string[];
  onboarding_support: string;
}> = {
  startup: {
    min_revenue: 0,
    revenue_share_percent: 15,
    benefits: [
      "Standard revenue share (15%)",
      "Email support",
      "Partner portal access",
      "Marketing co-op funds ($500/year)",
    ],
    onboarding_support: "Self-serve onboarding + partner guide",
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
    onboarding_support: "Dedicated onboarding specialist",
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
    onboarding_support: "Success manager + technical architect",
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
    onboarding_support: "C-level executive onboarding",
  },
};

/** Get partnership tier configuration. */
export function getPartnershipTier(
  tier: PartnershipTier
): {
  min_revenue: number;
  revenue_share_percent: number;
  benefits: string[];
  onboarding_support: string;
} {
  return PartnershipTiers[tier] || PartnershipTiers.growth;
}

/** Partner referral tracking. */
export interface ReferralTracking {
  referral_code: string;
  referred_by_partner_id: string;
  referred_customer_id: string;
  deal_id: string;
  status: "lead" | "qualified" | "closed_lost" | "closed_won";
  deal_value: number;
  revenue_share_credited: number;
  created_at: Date;
  closed_at?: Date;
}

/** API route to partner program endpoints. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "list";

    if (action === "tier") {
      const tier = searchParams.get("tier") as PartnershipTier || "growth";
      const tierConfig = getPartnershipTier(tier);

      return new Response(JSON.stringify({
        tier,
        config: tierConfig,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list partners (mock data for now)
    const partners: Partner[] = [
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
        benefits: [
          "Dedicated account manager",
          "Partner portal access",
          "Marketing co-op funds ($10,000/year)",
          "Co-selling with sales team",
          "Technical enablement + custom integration",
        ],
        assigned_account_manager: "john.smith@aerolexa.com",
        integrations_built: 8,
        integrations_certified: 5,
      },
      {
        id: "partner_2",
        name: "DataStream Analytics",
        email: "partners@datastream.io",
        tier: "growth",
        onboarding_date: new Date("2024-03-20"),
        status: "active",
        revenue_share_percent: 20,
        referral_code: "DS2024",
        referrals_made: 8,
        referrals_converted: 3,
        benefits: [
          "Priority email support",
          "Partner portal access",
          "Marketing co-op funds ($2,000/year)",
          "Co-selling opportunities",
          "Technical enablement workshops",
        ],
        integrations_built: 5,
        integrations_certified: 3,
      },
    ];

    return new Response(JSON.stringify({ partners }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Partnership program error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve partnership program data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/** Track a referral. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const {
      referral_code,
      referred_customer_id,
      deal_id,
      deal_value,
      status,
    } = body;

    // Calculate revenue share based on partner tier
    // In a real implementation, look up the partner's tier
    const revenue_share_percent = 20; // Default to growth tier
    const revenue_share_credited = Math.round(deal_value * (revenue_share_percent / 100));

    const referral: ReferralTracking = {
      referral_code,
      referred_by_partner_id: body.partner_id || "partner_1",
      referred_customer_id,
      deal_id,
      status,
      deal_value,
      revenue_share_credited,
      created_at: new Date(),
      closed_at: status === "closed_won" ? new Date() : undefined,
    };

    return new Response(JSON.stringify(referral), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Track referral error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to track referral" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}