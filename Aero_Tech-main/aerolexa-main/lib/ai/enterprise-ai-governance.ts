/**
 * Phase 62: Enterprise AI Governance and Model Audit
 *
 * Comprehensive AI governance framework with model audit trails, bias detection,
 * drift monitoring, compliance enforcement, and responsible AI controls. Integrates
 * with the autonomous decision engine (Phase 60), agent orchestration (Phase 57),
 * knowledge bases (Phase 52), and predictive analytics (Phase 56). Features
 * model versioning, performance tracking, and automatic compliance reporting.
 */
import { prisma } from "../lib/db";
import type { NextRequest } from "next/server";
import { executeDecision, DecisionRiskLevel, DecisionProposal } from "./autonomous-decision-engine";
import { checkGovernancePolicies, GovernanceFramework, AuditEventType } from "./governance/audit-management";

export type ModelType = "predictive_score" | "anomaly_detection" | "forecasting" | "classification" | "regression";

export interface ModelMetadata {
  id: string;
  name: string;
  model_type: ModelType;
  industry: Industry;
  version: string;
  description: string;
  training_date: Date;
  data_snapshot: string; // Reference to training data
  features_used: string[];
  target_variable: string;
  accuracy: number; // 0-100
  last_evaluated: Date;
  status: "active" | "retired" | "under_review" | "deprecated";
  compliance_frameworks: GovernanceFramework[];
  drift_threshold: number; // % change triggering re-evaluation
  performance_baseline: number; // Baseline accuracy at deployment
}

export interface ModelDriftReport {
  id: string;
  model_id: string;
  evaluated_at: Date;
  drift_score: number; // 0-100, higher is more drift
  performance_change: number; // % change in accuracy
  data_drift: number; // % change in feature distribution
  concept_drift: boolean; // True if underlying patterns changed
  recommended_action: "monitor" | "retrain" | "replace" => "retrain" | "restart";
  triggered_by: "automatic" | "manual";
  audit_trail: AuditEvent[];
}

export interface AIGovernanceReport {
  model_id: string;
  overall_compliance: number; // 0-100
  risk_score: number; // 0-100, higher is more risk
  drift_reports: ModelDriftReport[];
  active_models: ModelMetadata[];
  recommendations: string[];
  generated_at: Date;
}

 /** Check model compliance across frameworks. */
function checkModelCompliance(
  model: ModelMetadata,
  framework: GovernanceFramework
): {
  compliant: boolean;
  violations: string[];
  risk_adjustment: number;
} {
  const violations: string[] = [];
  let riskAdjustment = 0;

  switch (framework) {
    case "SOC2":
      if (model.accuracy < 80) {
        violations.push("Accuracy below SOC2 threshold (80%)");
        riskAdjustment += 15;
      }
      if (model.features_used.length > 20) {
        violations.push("Excessive features may impact SOC2 auditability");
        riskAdjustment += 5;
      }
      break;
    case "HIPAA":
      if (!model.compliance_frameworks.includes("HIPAA")) {
        violations.push("Model not certified for HIPAA compliance");
        riskAdjustment += 30;
      }
      break;
    case "PCI_DSS":
      if (!model.compliance_frameworks.includes("PCI_DSS")) {
        violations.push("Model not PCI-DSS certified for payment data");
        riskAdjustment += 30;
      }
      break;
    case "GDPR":
      if (model.features_used.some(f => f.includes("personal")) && !model.compliance_frameworks.includes("GDPR")) {
        violations.push("Model uses personal data without GDPR compliance");
        riskAdjustment += 25;
      }
      break;
    case "SOX":
      if (model.training_date > new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) === false) {
        violations.push("Model training date outside SOX documentation window");
        riskAdjustment += 10;
      }
      break;
  }

  return {
    compliant: violations.length === 0,
    violations,
    risk_adjustment,
  };
}

/** Generate AI governance report. */
export function generateAIGovernanceReport(
  modelId: string,
  model: ModelMetadata,
  driftReports: ModelDriftReport[]
): AIGovernanceReport {
  // Calculate overall compliance
  const frameworks: GovernanceFramework[] = ["SOC2", "HIPAA", "PCI_DSS", "GDPR", "SOX"];
  let totalCompliance = 0;
  let totalRisk = 0;
  let compliantCount = 0;

  frameworks.forEach((framework) => {
    const check = checkModelCompliance(model, framework);
    totalCompliance += check.compliant ? 20 : 0; // 20 points per framework
    totalRisk += check.risk_adjustment;
    if (check.compliant) compliantCount++;
  });

  totalCompliance = Math.min(100, totalCompliance);
  const averageRisk = totalRisk / frameworks.length;

  // Generate recommendations
  const recommendations: string[] = [];
  
  if (!model.compliant) {
    recommendations.push("Review model compliance across regulatory frameworks");
  }
  if (model.drift_threshold > 0 && driftReports.length > 0) {
    const criticalDrifts = driftReports.filter(d => d.drift_score > 50);
    if (criticalDrifts.length > 0) {
      recommendations.push(`Address ${criticalDrifts.length} critical drift events with immediate retraining`);
    }
  }
  if (model.accuracy < 85) {
    recommendations.push("Consider model retraining to improve accuracy above 85% threshold");
  }
  if (model.status === "active" && model.last_evaluated < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) {
    recommendations.push("Model evaluation overdue: schedule retraining assessment");
  }

  return {
    model_id: modelId,
    overall_compliance: totalCompliance,
    risk_score: Math.max(0, Math.min(100, 100 - totalRisk)),
    drift_reports,
    active_models: [model],
    recommendations,
    generated_at: new Date(),
  };
}

/** API route for enterprise AI governance. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "report";

    if (action === "report") {
      const modelId = searchParams.get("model_id") || "model_1";

      // Mock model metadata for demonstration
      const model: ModelMetadata = {
        id: modelId,
        name: "Predictive Revenue Model",
        model_type: "predictive_score" as ModelType,
        industry: "saas" as Industry,
        version: "2.3.0",
        description: "Predicts monthly recurring revenue based on historical trends and usage patterns",
        training_date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
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

      // Mock drift reports
      const driftReports: ModelDriftReport[] = [
        {
          id: `drift_1`,
          model_id: modelId,
          evaluated_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          drift_score: 8,
          performance_change: -2,
          data_drift: 5,
          concept_drift: false,
          recommended_action: "monitor",
          triggered_by: "automatic",
          audit_trail: [],
        },
      ];

      const report = generateAIGovernanceReport(modelId, model, driftReports);

      return new Response(JSON.stringify(report), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list governance frameworks
    const frameworks: GovernanceFramework[] = ["SOC2", "HIPAA", "PCI_DSS", "GDPR", "SOX"];

    return new Response(JSON.stringify({ frameworks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Enterprise AI governance error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve AI governance data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}