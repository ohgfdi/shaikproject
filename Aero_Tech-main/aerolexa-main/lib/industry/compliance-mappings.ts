/**
 * Phase 37: Compliance Mappings Per Industry
 *
 * Maps industry-specific compliance requirements (HIPAA, SOC2, PCI-DSS, GDPR)
 * to tenant configurations and audit logging requirements.
 */
import type { NextRequest } from "next/server";


export type ComplianceFramework = "HIPAA" | "SOC2" | "PCI_DSS" | "GDPR";

export interface IndustryComplianceMap {
  industry: "finance" | "healthcare" | "saas" | "retail" | "manufacturing" | "unknown";
  frameworks: Partial<Record<ComplianceFramework, ComplianceRequirements>>;
}

export interface ComplianceRequirements {
  // Whether framework applies to this industry
  applicable: boolean;
  // Required audit log categories
  requiredAuditCategories: string[];
  // Data retention periods (days)
  retentionDays: number;
  // Encryption requirements
  encryptionAtRest: boolean;
  encryptionInTransit: boolean;
  // Access control requirements
  minPasswordLength: number;
  sessionTimeoutMinutes: number;
  // Allowed login attempts
  maxLoginAttempts: number;
  // Data residency requirements
  allowedRegions: string[];
  // Feature restrictions
  restrictedFeatures: string[];
  // Additional requirements
  customRequirements: string[];
}

/** Get compliance requirements for a specific industry and framework. */
export function getComplianceRequirements(
  industry: string,
  framework: ComplianceFramework
): ComplianceRequirements {
  const maps: IndustryComplianceMap[] = [
    {
      industry: "finance",
      frameworks: {
        HIPAA: { applicable: false, requiredAuditCategories: [], retentionDays: 2555, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 12, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["US", "EU"], restrictedFeatures: [], customRequirements: ["SOX", "Basel-III"] },
        SOC2: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 2555, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 12, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["US", "EU"], restrictedFeatures: [], customRequirements: ["SOX"] },
        PCI_DSS: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 3650, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 15, maxLoginAttempts: 3, allowedRegions: ["US", "EU"], restrictedFeatures: [], customRequirements: ["SAS70"] },
        GDPR: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event", "dsar"], retentionDays: 2555, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 12, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["EU"], restrictedFeatures: [], customRequirements: ["DSAR process", "Breach notification 72h"] },
      },
    },
    {
      industry: "healthcare",
      frameworks: {
        HIPAA: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event", "phi-access"], retentionDays: 2555, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 12, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["US"], restrictedFeatures: ["unencrypted-email"], customRequirements: ["Risk Analysis", "BAA", "Technical Safeguards"] },
        SOC2: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 2555, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 12, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["US"], restrictedFeatures: [], customRequirements: ["Technical Safeguards", "Audit Logs"] },
        PCI_DSS: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 3650, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 15, maxLoginAttempts: 3, allowedRegions: ["US"], restrictedFeatures: [], customRequirements: ["Encryption, Tokenization"] },
        GDPR: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event", "dsar"], retentionDays: 2555, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 12, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["EU"], restrictedFeatures: [], customRequirements: ["DSAR process", "Breach notification 72h"] },
      },
    },
    {
      industry: "saas",
      frameworks: {
        HIPAA: { applicable: false, requiredAuditCategories: [], retentionDays: 1095, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 10, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: [] },
        SOC2: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 1095, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 10, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: ["Documentation", "Annual Assessment"] },
        PCI_DSS: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 3650, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 15, maxLoginAttempts: 3, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: ["SAQ A"] },
        GDPR: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event", "dsar"], retentionDays: 1095, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 10, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["EU", "Global"], restrictedFeatures: [], customRequirements: ["DSAR process", "Breach notification 72h", "DPIA"] },
      },
    },
    {
      industry: "retail",
      frameworks: {
        HIPAA: { applicable: false, requiredAuditCategories: [], retentionDays: 365, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: [] },
        SOC2: { applicable: false, requiredAuditCategories: [], retentionDays: 365, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: [] },
        PCI_DSS: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 3650, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 15, maxLoginAttempts: 3, allowedRegions: ["Global"], restrictedFeatures: ["unencrypted-storage"], customRequirements: ["Encryption, Tokenization, truncation"] },
        GDPR: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event", "dsar"], retentionDays: 365, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 30, maxLoginAttempts: 5, allowedRegions: ["EU"], restrictedFeatures: [], customRequirements: ["DSAR process", "Breach notification 72h"] },
      },
    },
    {
      industry: "manufacturing",
      frameworks: {
        HIPAA: { applicable: false, requiredAuditCategories: [], retentionDays: 1825, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 10, sessionTimeoutMinutes: 60, maxLoginAttempts: 5, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: [] },
        SOC2: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event"], retentionDays: 1825, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 10, sessionTimeoutMinutes: 60, maxLoginAttempts: 5, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: ["ISO 9001 alignment"] },
        PCI_DSS: { applicable: false, requiredAuditCategories: [], retentionDays: 3650, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 8, sessionTimeoutMinutes: 15, maxLoginAttempts: 3, allowedRegions: ["Global"], restrictedFeatures: [], customRequirements: [] },
        GDPR: { applicable: true, requiredAuditCategories: ["access-log", "data-change", "auth-event", "dsar"], retentionDays: 1825, encryptionAtRest: true, encryptionInTransit: true, minPasswordLength: 10, sessionTimeoutMinutes: 60, maxLoginAttempts: 5, allowedRegions: ["EU"], restrictedFeatures: [], customRequirements: ["DSAR process", "Breach notification 72h"] },
      },
    },
  ];

  const map = maps.find((m) => m.industry === industry);
  if (!map) {
    // Default generic requirements
    return {
      applicable: false,
      requiredAuditCategories: [],
      retentionDays: 365,
      encryptionAtRest: true,
      encryptionInTransit: true,
      minPasswordLength: 10,
      sessionTimeoutMinutes: 30,
      maxLoginAttempts: 5,
      allowedRegions: ["Global"],
      restrictedFeatures: [],
      customRequirements: [],
    };
  }

  return map.frameworks[framework] || {
    applicable: false,
    requiredAuditCategories: [],
    retentionDays: 365,
    encryptionAtRest: true,
    encryptionInTransit: true,
    minPasswordLength: 10,
    sessionTimeoutMinutes: 30,
    maxLoginAttempts: 5,
    allowedRegions: ["Global"],
    restrictedFeatures: [],
    customRequirements: [],
  };
}

/** Get all compliance requirements for an industry. */
export function getIndustryComplianceMap(industry: string): IndustryComplianceMap {
  const maps: IndustryComplianceMap[] = [
    { industry: "finance", frameworks: {} },
    { industry: "healthcare", frameworks: {} },
    { industry: "saas", frameworks: {} },
    { industry: "retail", frameworks: {} },
    { industry: "manufacturing", frameworks: {} },
  ];

  const map = maps.find((m) => m.industry === industry);
  if (!map) {
    return { industry: "unknown", frameworks: {} };
  }

  // Fill in the frameworks from the definitions above
  // This is a simplified version - in production would import the full maps
  return map;
}

/** API route to get compliance requirements. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const industry = searchParams.get("industry") || "saas";
    const framework = searchParams.get("framework") as ComplianceFramework || "SOC2";

    const requirements = getComplianceRequirements(industry, framework);

    return new Response(JSON.stringify(requirements), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Compliance mappings error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve compliance requirements" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}