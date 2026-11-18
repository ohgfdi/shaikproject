/**
 * Phase 71: ISV Partner Program - Tier Structure
 *
 * Independent Software Vendor partner program with 4 tiers.
 * Enables co-selling, revenue share, and partner enablement.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export type PartnerTier = "startup" | "growth" | "enterprise" | "elite";

export type PartnerStatus = "pending" | "approved" | "active" | "paused" | "terminated";

export interface PartnerTierDefinition {
  tier: PartnerTier;
  name: string;
  description: string;
  minimumRevenueShare: number; // percentage
  maximumRevenueShare: number; // percentage
  requiredARR: number; // annual recurring revenue required
  requiredCustomers: number; // minimum customer count
  benefits: string[];
  commissionRate: number; // percentage per deal
  onboardingRequirements: string[];
  dealRegistrationPeriod: number; // days to register a deal
  dealCloseWindow: number; // days to close a registered deal
}

export const PARTNER_TIER_DEFINITIONS: Record<PartnerTier, PartnerTierDefinition> = {
  startup: {
    tier: "startup",
    name: "Startup Partner",
    description: "Early-stage ISV partner program entry tier",
    minimumRevenueShare: 5,
    maximumRevenueShare: 10,
    requiredARR: 0,
    requiredCustomers: 0,
    benefits: [
      "Access to partner portal",
      "Co-marketing support",
      "Technical enablement sessions",
      "Partner API access",
      "Joint pipeline reviews"
    ],
    commissionRate: 5,
    onboardingRequirements: [
      "Company website verification",
      "Founder intro call",
      "First integration demo"
    ],
    dealRegistrationPeriod: 90,
    dealCloseWindow: 180,
  },
  growth: {
    tier: "growth",
    name: "Growth Partner",
    description: "Mature ISV partner with growing pipeline",
    minimumRevenueShare: 10,
    maximumRevenueShare: 15,
    requiredARR: 100000,
    requiredCustomers: 5,
    benefits: [
      "All Startup tier benefits",
      "Dedicated technical account manager",
      "Priority support",
      "Enablement webinars",
      "Partner success roadmap"
    ],
    commissionRate: 10,
    onboardingRequirements: [
      "Completed Startup tier requirements",
      "Integration completed in staging",
      "3 successful pilot customers"
    ],
    dealRegistrationPeriod: 60,
    dealCloseWindow: 120,
  },
  enterprise: {
    tier: "enterprise",
    name: "Enterprise Partner",
    description: "Established ISV with significant market presence",
    minimumRevenueShare: 15,
    maximumRevenueShare: 20,
    requiredARR: 500000,
    requiredCustomers: 15,
    benefits: [
      "All Growth tier benefits",
      "Executive sponsorship",
      "Joint go-to-market planning",
      "Pipeline contribution credits",
      "Training budget allocation"
    ],
    commissionRate: 15,
    onboardingRequirements: [
      "Completed Growth tier requirements",
      "SOX/SOC 2 compliance documentation",
      "6+ joint customers",
      "Co-selling agreement signed"
    ],
    dealRegistrationPeriod: 30,
    dealCloseWindow: 90,
  },
  elite: {
    tier: "elite",
    name: "Elite Partner",
    description: " strategic ISV partner with strategic importance",
    minimumRevenueShare: 20,
    maximumRevenueShare: 30,
    requiredARR: 2000000,
    requiredCustomers: 50,
    benefits: [
      "All Enterprise tier benefits",
      "Executive executive steering committee",
      "Custom development funding",
      "Priority co-selling with sales team",
      "Revenue guarantee program",
      "Training and certification budget"
    ],
    commissionRate: 20,
    onboardingRequirements: [
      "Completed Enterprise tier requirements",
      "Market jointly validated",
      "10+ joint customers",
      "Strategic alignment confirmed",
      "Executive-level commitment"
    ],
    dealRegistrationPeriod: 14,
    dealCloseWindow: 45,
  },
};

export interface PartnerProfile {
  id: string;
  companyName: string;
  tier: PartnerTier;
  status: PartnerStatus;
  arR: number;
  customerCount: number;
  annualRevenue: number;
  contactName: string;
  contactEmail: string;
  country: string;
  website?: string;
  integrationStatus?: "planned" | "in-progress" | "completed";
  registeredDeals: number;
  closedDeals: number;
  totalEarnings: number;
  lastActivityDate: Date;
  metadata?: Record<string, unknown>;
}

export function getTierInfo(tier: PartnerTier): PartnerTierDefinition {
  return PARTNER_TIER_DEFINITIONS[tier];
}

export function canRegisterDeal(tier: PartnerTier, dealAgeDays: number): boolean {
  const tierDef = PARTNER_TIER_DEFINITIONS[tier];
  return dealAgeDays <= tierDef.dealRegistrationPeriod;
}

export function canCloseDeal(tier: PartnerTier, daysSinceRegistration: number): boolean {
  const tierDef = PARTNER_TIER_DEFINITIONS[tier];
  return daysSinceRegistration <= tierDef.dealCloseWindow;
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "tiers";

    if (action === "tiers") {
      const tiers = Object.keys(PARTNER_TIER_DEFINITIONS).map((key) => ({
        key: key as keyof typeof PARTNER_TIER_DEFINITIONS,
        ...PARTNER_TIER_DEFINITIONS[key as keyof typeof PARTNER_TIER_DEFINITIONS],
      }));
      return new Response(JSON.stringify({ tiers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "tier") {
      const tier = (searchParams.get("tier") || "startup") as PartnerTier;
      const result = getTierInfo(tier);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "eligible") {
      const tier = (searchParams.get("tier") || "startup") as PartnerTier;
      const arR = parseFloat(searchParams.get("arR") || "0");
      const customerCount = parseInt(searchParams.get("customerCount") || "0", 10);
      const tierDef = PARTNER_TIER_DEFINITIONS[tier];
      const eligible = 
        arR >= tierDef.requiredARR &&
        customerCount >= tierDef.requiredCustomers;
      return new Response(JSON.stringify({ tier, eligible, requirements: tierDef.requiredARR, customerCount: tierDef.requiredCustomers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list tiers
    const tiers = Object.keys(PARTNER_TIER_DEFINITIONS).map((key) => ({
      key: key as string,
      ...PARTNER_TIER_DEFINITIONS[key as PartnerTier],
    }));
    return new Response(JSON.stringify({ tiers }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Partner program error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve partner program data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
