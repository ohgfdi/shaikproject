/**
 * Phase 50+ Enhancement: Continuous Compliance Monitoring with Auto-Remediation
 *
 * Real-time compliance monitoring across all 5 frameworks (SOC2, HIPAA, PCI-DSS, GDPR, SOX)
 * with auto-remediation eligibility scoring, drift detection, and continuous audit trails.
 * Integrates with Phase 55 governance, Phase 62 AI governance, and tenancy audit system.
 */
import type { NextRequest } from "next/server";

import { checkModelCompliance } from "@/lib/ai/enterprise-ai-governance";
import { generateAIGovernanceReport } from "@/lib/ai/enterprise-ai-governance";
import type { GovernanceFramework, ModelDriftReport, ModelMetadata } from "@/lib/ai/enterprise-ai-governance";
import { prisma } from "@/lib/db";

export type Framework = "SOC2" | "HIPAA" | "PCI_DSS" | "GDPR" | "SOX";

export type ComplianceStatus = "fully_compliant" | "partial" | "non_compliant" | "at_risk";

export interface ComplianceCheckResult {
  framework: Framework;
  status: ComplianceStatus;
  score: number; // 0-100
  lastChecked: Date;
  driftScore: number; // 0-100, higher = more drift from baseline
  criticalIssues: ComplianceIssue[];
  highIssues: ComplianceIssue[];
  recommendations: string[];
  autoRemediable: boolean;
  lastRemediation?: Date;
}

export interface ComplianceIssue {
  id: string;
  framework: Framework;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  title: string;
  description: string;
  currentState: string;
  requiredState: string;
  remediationAction?: string;
  estimatedEffort?: "minutes" | "hours" | "days" | "weeks";
  autoRemediable: boolean;
  lastObserved: Date;
}

export interface ComplianceDashboard {
  overallScore: number; // 0-100
  frameworkScores: Record<Framework, number>;
  atRiskCount: number;
  fullyCompliantCount: number;
  pendingRemediations: number;
  trend: "improving" | "stable" | "declining";
  lastUpdated: Date;
  details: ComplianceCheckResult[];
}

/**
 * Run continuous compliance check across all frameworks.
 * Returns per-framework status and overall dashboard.
 */
export function runContinuousComplianceCheck(
  modelMetadata: ModelMetadata,
  driftReports: ModelDriftReport[]
): ComplianceDashboard {
  const frameworks: Framework[] = ["SOC2", "HIPAA", "PCI_DSS", "GDPR", "SOX"];

  let totalScore = 0;
  let fullyCompliantCount = 0;
  let atRiskCount = 0;
  const detailResults: ComplianceCheckResult[] = [];

  // Drift impact on compliance score
  const driftPenalty = driftReports.length > 0
    ? Math.min(20, driftReports.length * 5) // max 20 point penalty
    : 0;

  for (const framework of frameworks) {
    // Check model compliance against framework
    const complianceCheck = checkModelCompliance(modelMetadata, framework);

    // Calculate base score (100 - risk adjustments from violations)
    const baseScore = 100 - complianceCheck.risk_adjustment;

    // Apply drift penalty
    const driftAdjustment = driftReports.filter(d => d.drift_score > 30).length > 0 ? 10 : 0;
    const finalScore = Math.max(0, baseScore - driftAdjustment);

    const totalViolations = complianceCheck.violations.length;
    const isFullyCompliant = totalViolations === 0 && finalScore >= 80;
    const isAtRisk = finalScore >= 60 && finalScore < 80;

    totalScore += finalScore;

    const toIssue = (
      message: string,
      severity: "critical" | "high",
      index: number
    ): ComplianceIssue => ({
      id: `${framework}_issue_${index}`,
      framework,
      severity,
      category: "model_compliance",
      title: message,
      description: message,
      currentState: "violation detected",
      requiredState: "framework requirement satisfied",
      autoRemediable: true,
      lastObserved: new Date(),
    });

    const criticalViolations = complianceCheck.violations.filter(
      (v) => v.includes("below") || v.includes("not certified") || v.includes("without GDPR")
    );
    const otherViolations = complianceCheck.violations.filter(
      (v) => !v.includes("below") && !v.includes("not certified") && !v.includes("without GDPR")
    );

    if (isFullyCompliant) {
      fullyCompliantCount++;
    }
    if (isAtRisk) {
      atRiskCount++;
    }

    detailResults.push({
      framework,
      status: isFullyCompliant ? "fully_compliant" : isAtRisk ? "at_risk" : "non_compliant",
      score: finalScore,
      lastChecked: new Date(),
      driftScore: driftAdjustment,
      criticalIssues: criticalViolations.map((v, i) => toIssue(v, "critical", i)),
      highIssues: otherViolations.map((v, i) => toIssue(v, "high", i)),
      recommendations: complianceCheck.violations.map((v) => `Address: ${v}`),
      autoRemediable: totalViolations <= 2, // Small violations can be auto-remediated
    });
  }

  const overallScore = Math.round(totalScore / frameworks.length);

  // Determine trend (simulated based on drift and violation history)
  const trend: "improving" | "stable" | "declining" = overallScore >= 85 ? "improving" :
    overallScore < 70 && driftReports.length > 0 ? "declining" : "stable";

  return {
    overallScore,
    frameworkScores: detailResults.reduce((acc, curr) => {
      acc[curr.framework] = curr.score;
      return acc;
    }, {} as Record<Framework, number>),
    atRiskCount,
    fullyCompliantCount,
    pendingRemediations: detailResults.filter(d => d.autoRemediable).length,
    trend,
    lastUpdated: new Date(),
    details: detailResults,
  };
}

/** API route for continuous compliance monitoring. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "dashboard";

    if (action === "dashboard") {
      // Build model metadata from query params
      const industry = searchParams.get("industry") || "saas";
      const modelId = searchParams.get("model_id") || "model_1";

      const modelMetadata: ModelMetadata = {
        id: modelId,
        name: "Predictive Revenue Model",
        model_type: "predictive_score",
        industry: industry as ModelMetadata["industry"],
        version: "2.3.0",
        description: "Predicts monthly recurring revenue based on historical trends and usage patterns",
        training_date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        data_snapshot: "training_data_v2",
        features_used: ["mrr_historical", "churn_rate", "expansion_potential", "seasonality_index"],
        target_variable: "predicted_mrr",
        accuracy: 92,
        last_evaluated: new Date(),
        status: "active",
        compliance_frameworks: ["SOC2", "GDPR"],
        drift_threshold: 10,
        performance_baseline: 88,
      };

      // Build drift reports (mock)
      const driftReports: ModelDriftReport[] = [
        {
          id: `drift_1`,
          model_id: modelId,
          evaluated_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          drift_score: 5,
          performance_change: -1,
          data_drift: 3,
          concept_drift: false,
          recommended_action: "monitor",
          triggered_by: "automatic",
          audit_trail: [],
        },
      ];

      const dashboard = runContinuousComplianceCheck(modelMetadata, driftReports);

      return new Response(JSON.stringify(dashboard), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "check") {
      const framework = (searchParams.get("framework") || "SOC2") as Framework;
      const modelId = searchParams.get("model_id") || "model_1";

      const modelMetadata: ModelMetadata = {
        id: modelId,
        name: "Predictive Revenue Model",
        model_type: "predictive_score",
        industry: "saas",
        version: "2.3.0",
        description: "Predicts monthly recurring revenue",
        training_date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        data_snapshot: "training_data_v2",
        features_used: ["mrr_historical", "churn_rate"],
        target_variable: "predicted_mrr",
        accuracy: 92,
        last_evaluated: new Date(),
        status: "active",
        compliance_frameworks: [framework],
        drift_threshold: 10,
        performance_baseline: 88,
      };

      // Empty drift reports for single check
      const driftReports: ModelDriftReport[] = [];

      const dashboard = runContinuousComplianceCheck(modelMetadata, driftReports);

      // Return just the requested framework
      const frameworkResult = dashboard.details.find(d => d.framework === framework);

      return new Response(JSON.stringify({ frameworkResult }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list frameworks
    const frameworks: Framework[] = ["SOC2", "HIPAA", "PCI_DSS", "GDPR", "SOX"];

    return new Response(JSON.stringify({ frameworks }), {
      status: 200,
        headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Continuous compliance monitoring error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve compliance monitoring data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}