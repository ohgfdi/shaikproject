/**
 * Phase 45: Multi-Region Data Residency
 *
 * Compliance and configuration for multi-region data residency.
 * Ensures data is stored and processed in compliance with regional
 * regulations (GDPR EU, CCPA US, PDPA APAC, etc.).
 */
import { prisma } from "../lib/db";
import type { NextRequest } from "next/server";

export type Region = "us-east-1" | "eu-central-1" | "ap-southeast-1" | "sa-east-1";

export type DataResidencyLevel = "local" | "regional" | "global";

export interface RegionConfig {
  code: Region;
  name: string;
  // Allowed data operations
  allowed_operations: string[];
  // Compliance frameworks applicable
  compliance_frameworks: string[];
  // Data residency level
  residency_level: DataResidencyLevel;
  // Minimum encryption requirements
  min_encryption: "AES-128" | "AES-256";
  // Allowed tenant plans
  allowed_plans: ("free" | "pro" | "enterprise")[];
  // Region-specific features
  features: string[];
}

export const RegionConfigs: Record<Region, RegionConfig> = {
  "us-east-1": {
    code: "us-east-1",
    name: "US East (N. Virginia)",
    allowed_operations: ["read", "write", "process", "analyze"],
    compliance_frameworks: ["CCPA", "SOC2"],
    residency_level: "local",
    min_encryption: "AES-256",
    allowed_plans: ["free", "pro", "enterprise"],
    features: ["English", "Spanish"],
  },
  "eu-central-1": {
    code: "eu-central-1",
    name: "Europe (Frankfurt)",
    allowed_operations: ["read", "write", "process", "analyze", "store"],
    compliance_frameworks: ["GDPR", "SOC2"],
    residency_level: "local",
    min_encryption: "AES-256",
    allowed_plans: ["pro", "enterprise"],
    features: ["English", "German", "French", "Spanish"],
  },
  "ap-southeast-1": {
    code: "ap-southeast-1",
    name: "Asia Pacific (Singapore)",
    allowed_operations: ["read", "write", "process", "analyze"],
    compliance_frameworks: ["PDPA", "SOC2"],
    residency_level: "regional",
    min_encryption: "AES-256",
    allowed_plans: ["pro", "enterprise"],
    features: ["English", "Japanese", "Chinese", "Arabic"],
  },
  "sa-east-1": {
    code: "sa-east-1",
    name: "South America (São Paulo)",
    allowed_operations: ["read", "write"],
    compliance_frameworks: ["LGPD", "SOC2"],
    residency_level: "regional",
    min_encryption: "AES-256",
    allowed_plans: ["enterprise"],
    features: ["Portuguese", "Spanish", "English"],
  },
};

/** Get region config by code. */
export function getRegionConfig(code: Region): RegionConfig {
  return RegionConfigs[code] || RegionConfigs["us-east-1"];
}

/** Get allowed regions for a tenant plan. */
export function getAllowedRegions(plan: "free" | "pro" | "enterprise"): Region[] {
  const allowed: Region[] = [];

  if (plan === "free" || plan === "pro" || plan === "enterprise") {
    allowed.push("us-east-1");
  }
  if (plan === "pro" || plan === "enterprise") {
    allowed.push("eu-central-1");
  }
  if (plan === "enterprise") {
    allowed.push("ap-southeast-1");
    allowed.push("sa-east-1");
  }

  return allowed;
}

/** Check if a region is allowed for a tenant plan. */
export function isRegionAllowed(plan: "free" | "pro" | "enterprise", region: Region): boolean {
  const allowed = getAllowedRegions(plan);
  return allowed.includes(region);
}

/** API route to get region configs. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "list";

    if (action === "config") {
      const code = searchParams.get("code") as Region || "us-east-1";
      const config = getRegionConfig(code);

      return new Response(JSON.stringify({ code, config }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "allowed-regions") {
      const plan = searchParams.get("plan") as "free" | "pro" | "enterprise" || "pro";
      const regions = getAllowedRegions(plan);

      return new Response(JSON.stringify({ plan, regions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list all regions
    const regions = Object.keys(RegionConfigs) as Region[];
    const regionConfigs = regions.map((code) => getRegionConfig(code));

    return new Response(JSON.stringify({ regions, configs: regionConfigs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Multi-region data residency error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve region configuration" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}