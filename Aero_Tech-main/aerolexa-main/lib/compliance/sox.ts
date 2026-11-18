/**
 * Phase 64: SOX Compliance Module
 *
 * Sarbanes-Oxley Act compliance financial reporting, audit trails,
 * and executive dashboards for public company customers.
 */
import type { NextRequest } from "next/server";


export type SoxSection = "302" | "404" | "409" | "802" | "906";

export type SoxStatus = "compliant" | "partial" | "at_risk" | "non_compliant" | "not_applicable";

export interface SoxControl {
  id: string;
  section: SoxSection;
  title: string;
  description: string;
  requirement: string;
  testing_procedure: string;
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "annually";
  last_tested?: Date;
  next_due?: Date;
  status: SoxStatus;
  tested_by?: string;
  evidence_path?: string;
  deficiencies: SoxDeficiency[];
}

export interface SoxDeficiency {
  id: string;
  control_id: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  remediation_required: boolean;
  resolved_at?: Date;
  resolved_by?: string;
}

export interface SoxDashboard {
  overallScore: number; // 0-100
  sectionScores: Record<SoxSection, number>;
  atRiskCount: number;
  fullyCompliantCount: number;
  totalControls: number;
  criticalDeficiencies: number;
  lastUpdated: Date;
  details: SoxControl[];
}

export function runSoxCheck(): SoxDashboard {
  const sections: SoxSection[] = ["302", "404", "409", "802", "906"];

  let totalScore = 0;
  let fullyCompliantCount = 0;
  let atRiskCount = 0;
  let criticalDeficiencies = 0;
  const detailControls: SoxControl[] = [];
  const sectionScores = {} as Record<SoxSection, number>;

  for (const section of sections) {
    // Mock compliance check - in production this would query actual controls
    const baseScore = 85; // Baseline score per section
     // Typical controls per section
    const criticalDeficiencyCount = Math.floor(Math.random() * 3); // 0-2 random

    const sectionScore = Math.max(0, baseScore - criticalDeficiencyCount * 15);
    const isFullyCompliant = sectionScore >= 80;
    const isAtRisk = sectionScore >= 60 && sectionScore < 80;

    totalScore += sectionScore;
    sectionScores[section] = sectionScore;
    if (isFullyCompliant) {
      fullyCompliantCount++;
    }
    if (isAtRisk) {
      atRiskCount++;
    }
    if (criticalDeficiencyCount > 0) {
      criticalDeficiencies++;
    }

    const deficiencies: SoxDeficiency[] = [];
    for (let i = 0; i < criticalDeficiencyCount; i++) {
      deficiencies.push({
        id: `def_${section}_${i}`,
        control_id: `ctrl_${section}_${i}`,
        severity: "critical",
        description: `Critical deficiency in section ${section}`,
        remediation_required: true,
        resolved_at: undefined,
        resolved_by: undefined,
      });
    }

    // Add some high severity deficiencies too
    const highDeficiencyCount = Math.floor(Math.random() * 2); // 0-1
    for (let i = 0; i < highDeficiencyCount; i++) {
      deficiencies.push({
        id: `def_high_${section}_${i}`,
        control_id: `ctrl_high_${section}_${i}`,
        severity: "high",
        description: `High severity issue in section ${section}`,
        remediation_required: true,
        resolved_at: undefined,
        resolved_by: undefined,
      });
    }

    detailControls.push({
      id: `ctrl_${section}`,
      section,
      title: `SOX Section ${section} Control`,
      description: `SOX Section ${section} compliance requirement`,
      requirement: `Documentation and testing for section ${section}`,
      testing_procedure: `Perform ${section} testing quarterly`,
      frequency: "quarterly",
      last_tested: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      next_due: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      status: isFullyCompliant ? "compliant" : isAtRisk ? "at_risk" : "non_compliant",
      tested_by: "Compliance Team",
      evidence_path: `/evidence/sox/${section}.md`,
      deficiencies,
    });
  }

  const overallScore = Math.round(totalScore / sections.length);

  return {
    overallScore,
    sectionScores,
    atRiskCount,
    fullyCompliantCount:
      fullyCompliantCount,
    totalControls: sections.length * 10,
    criticalDeficiencies,
    lastUpdated: new Date(),
    details: detailControls,
  };
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "dashboard";

    if (action === "check") {
      const section = (searchParams.get("section") || "302") as SoxSection;

      const dashboard = runSoxCheck();
      const sectionResult = dashboard.details.find(d => d.section === section);

      return new Response(JSON.stringify({ sectionResult }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: dashboard
    const dashboard = runSoxCheck();

    return new Response(JSON.stringify(dashboard), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("SOX compliance error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve SOX compliance data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
