/**
 * Phase 72: Revenue Share Automation
 *
 * Automated revenue share calculations and payouts for ISV partners.
 * Supports multi-tier commission structures, deal registration, and automatic tracking.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export type DealStatus = "registered" | "in_progress" | "closed_won" | "closed_lost" | "expired";

export type CommissionTier = "startup" | "growth" | "enterprise" | "elite";

export interface DealRegistration {
  id: string;
  partnerId: string;
  partnerTier: CommissionTier;
  dealId: string;
  dealName: string;
  estimatedValue: number;
  registrationDate: Date;
  registrationDeadline: Date;
  status: DealStatus;
  closedDate?: Date;
  actualRevenue: number; // revenue attributable to this deal
  commissionRate: number;
  commissionAmount: number;
  metadata?: Record<string, unknown>;
}

export interface CommissionCalculation {
  dealId: string;
  tier: CommissionTier;
  revenueBase: number;
  commissionRate: number;
  commissionAmount: number;
  netPartnerPayout: number;
  platformFee: number;
  calculatedAt: Date;
  status: "pending" | "approved" | "paid" | "disputed";
}

export interface PartnerPayoutSummary {
  partnerId: string;
  partnerName: string;
  tier: CommissionTier;
  totalRevenueGenerated: number;
  totalCommissionEarned: number;
  totalPayoutsMade: number;
  pendingPayouts: number;
  periodStart: Date;
  periodEnd: Date;
  dealCount: number;
  closedDealCount: number;
}

export function calculateCommission(
  tier: CommissionTier,
  revenue: number): CommissionCalculation {
  const tierDefs: Record<CommissionTier, { min: number; max: number; rate: number }> = {
    startup: { min: 0, max: 100000, rate: 0.05 },
    growth: { min: 100000, max: 500000, rate: 0.10 },
    enterprise: { min: 500000, max: 2000000, rate: 0.15 },
    elite: { min: 2000000, max: Infinity, rate: 0.20 },
  };

  const tierInfo = tierDefs[tier];
  const commissionRate = tierInfo.rate;
  const commissionAmount = Math.round(revenue * commissionRate);
  const platformFee = Math.round(commissionAmount * 0.1); // 10% platform fee
  const netPartnerPayout = commissionAmount - platformFee;

  return {
    dealId: "calc_" + Date.now(),
    tier,
    revenueBase: revenue,
    commissionRate,
    commissionAmount,
    platformFee,
    netPartnerPayout,
    calculatedAt: new Date(),
    status: "pending",
  };
}

export function canPartnerCloseDeal(tier: CommissionTier, daysSinceRegistration: number): boolean {
  const registrationWindows: Record<CommissionTier, number> = {
    startup: 90,
    growth: 60,
    enterprise: 30,
    elite: 14,
  };
  return daysSinceRegistration <= registrationWindows[tier];
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "calculations";

    if (action === "tier") {
      const tier = (searchParams.get("tier") || "growth") as CommissionTier;
      const calculation = calculateCommission(tier, 100000);
      return new Response(JSON.stringify(calculation), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "eligibility") {
      const tier = (searchParams.get("tier") || "growth") as CommissionTier;
      const arR = parseFloat(searchParams.get("arR") || "0");
      const customerCount = parseInt(searchParams.get("customerCount") || "0", 10);
      const windows = { startup: 90, growth: 60, enterprise: 30, elite: 14 };
      const eligible = arR >= (tier === "startup" ? 0 : tier === "growth" ? 100000 : tier === "enterprise" ? 500000 : 2000000) && customerCount >= (tier === "startup" ? 0 : tier === "growth" ? 5 : tier === "enterprise" ? 15 : 50);
      return new Response(JSON.stringify({ tier, eligible, minARR: tierDefs[tier]?.min, minCustomers: tierDefs[tier]?.minCustomers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: sample calculation
    const calculation = calculateCommission("growth", 100000);
    return new Response(JSON.stringify(calculation), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Revenue share error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve revenue share data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
