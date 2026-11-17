/**
 * Phase 80: Real-Time Anomaly Detection
 *
 * Detects unusual patterns and anomalies in metrics, logs, and system behavior.
 * Provides real-time alerting, anomaly classification, and root cause indicators.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export type AnomalySeverity = "critical" | "high" | "medium" | "low";

export type AnomalyType = 
  | "spike"
  | "drop"
  | "pattern_change"
  | "seasonality_shift"
  | "threshold_violation"
  | "outlier";

export interface AnomalyEvent {
  id: string;
  metricId: string;
  metricName: string;
  anomalyType: AnomalyType;
  severity: AnomalySeverity;
  currentValue: number;
  expectedValue: number;
  deviationPercentage: number;
  detectedAt: Date;
  timeRangeStart: Date;
  timeRangeEnd: Date;
  status: "active" | "resolved" | " dismissed";
  contributingFactors?: string[];
  resolutionNotes?: string;
  assignedTo?: string;
}

export interface AnomalyStats {
  totalAnomalies: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  byType: Record<AnomalyType, number>;
  bySeverity: Record<AnomalySeverity, number>;
  resolvedPercentage: number;
  meanTimeToDetect: number; // minutes
  meanTimeToResolve?: number; // minutes
}

export function detectAnomalies(
  metricId: string,
  metricName: string,
  currentValue: number,
  historicalValues: number[],
  thresholds: { upper: number; lower: number } = { upper: Infinity, lower: -Infinity },
): AnomalyEvent[] {
    const anomalies: AnomalyEvent[] = [];

    // Check upper threshold violation
    if (currentValue > thresholds.upper) {
      anomalies.push({
        id: `anom_${metricId}_upper`,
        metricId,
        metricName,
        anomalyType: "threshold_violation",
        severity: "high",
        currentValue,
        expectedValue: thresholds.upper,
        deviationPercentage: Math.round(((currentValue - thresholds.upper) / thresholds.upper) * 100),
        detectedAt: new Date(),
        timeRangeStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        timeRangeEnd: new Date(),
        status: "active",
        contributingFactors: ["Upper threshold exceeded"]
      });
    }

    // Check lower threshold violation
    if (currentValue < thresholds.lower) {
      anomalies.push({
        id: `anom_${metricId}_lower`,
        metricId,
        metricName,
        anomalyType: "threshold_violation",
        severity: "high",
        currentValue,
        expectedValue: thresholds.lower,
        deviationPercentage: Math.round(((thresholds.lower - currentValue) / Math.abs(thresholds.lower)) * 100),
        detectedAt: new Date(),
        timeRangeStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        timeRangeEnd: new Date(),
        status: "active",
        contributingFactors: ["Lower threshold exceeded"]
      });
    }

    // Check spike detection (current >> historical average)
    if (historicalValues.length > 0) {
      const historicalAverage = historicalValues.reduce((sum, val) => sum + val, 0) / historicalValues.length;
      const historicalStdDev = Math.sqrt(
        historicalValues.reduce((sum, val) => sum + Math.pow(val - historicalAverage, 2), 0) / historicalValues.length
      );

      // Z-score based detection
      const zScore = (currentValue - historicalAverage) / (historicalStdDev || 1);

      // Spike: value is > 2 standard deviations above average
      if (zScore > 2) {
        const deviationPct = Math.round(((currentValue - historicalAverage) / historicalAverage) * 100);
        anomalies.push({
          id: `anom_${metricId}_spike`,
          metricId,
          metricName,
          anomalyType: "spike",
          severity: zScore > 3 ? "critical" : "high",
          currentValue,
          expectedValue: Math.round(historicalAverage),
          deviationPercentage: deviationPct,
          detectedAt: new Date(),
          timeRangeStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
          timeRangeEnd: new Date(),
          status: "active",
          contributingFactors: ["Statistical spike detected", `Z-score: ${zScore.toFixed(2)}`]
        });
      }

      // Drop: value is > 2 standard deviations below average
      if (zScore < -2) {
        const deviationPct = Math.round(((currentValue - historicalAverage) / historicalAverage) * 100);
        anomalies.push({
          id: `anom_${metricId}_drop`,
          metricId,
          metricName,
          anomalyType: "drop",
          severity: zScore < -3 ? "critical" : "high",
          currentValue,
          expectedValue: Math.round(historicalAverage),
          deviationPercentage: deviationPct,
          detectedAt: new Date(),
          timeRangeStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
          timeRangeEnd: new Date(),
          status: "active",
          contributingFactors: ["Statistical drop detected", `Z-score: ${zScore.toFixed(2)}`]
        });
      }

      // Outlier detection using IQR method
      const sorted = [...historicalValues].sort((a, b) => a - b);
      const q1 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.25)]! : undefined;
      const q3 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.75)]! : undefined;
      const iqr = q3! - q1!;
      const lowerBound = q1! - 1.5 * iqr;
      const upperBound = q3! + 1.5 * iqr;

      if (currentValue < lowerBound) {
        anomalies.push({
          id: `anom_${metricId}_outlier_low`,
          metricId,
          metricName,
          anomalyType: "outlier",
          severity: "medium",
          currentValue,
          expectedValue: Math.round(lowerBound),
          deviationPercentage: Math.round(((lowerBound - currentValue) / Math.abs(lowerBound)) * 100),
          detectedAt: new Date(),
          timeRangeStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
          timeRangeEnd: new Date(),
          status: "active",
          contributingFactors: ["IQR-based outlier detection"]
        });
      }
      if (currentValue > upperBound) {
        anomalies.push({
          id: `anom_${metricId}_outlier_high`,
          metricId,
          metricName,
          anomalyType: "outlier",
          severity: "medium",
          currentValue,
          expectedValue: Math.round(upperBound),
          deviationPercentage: Math.round(((currentValue - upperBound) / upperBound) * 100),
          detectedAt: new Date(),
          timeRangeStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
          timeRangeEnd: new Date(),
          status: "active",
          contributingFactors: ["IQR-based outlier detection"]
        });
      }
    }

    return anomalies;
}

export function getAnomalyStats(events: AnomalyEvent[]): AnomalyStats {
  const total = events.length;
  const critical = events.filter((e) => e.severity === "critical").length;
  const high = events.filter((e) => e.severity === "high").length;
  const medium = events.filter((e) => e.severity === "medium").length;
  const low = events.filter((e) => e.severity === "low").length;

  const byType: Record<AnomalyType, number> = {
    spike: 0,
    drop: 0,
    pattern_change: 0,
    seasonality_shift: 0,
    threshold_violation: 0,
    outlier: 0,
  };

  const bySeverity: Record<AnomalySeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  let resolved = 0;

  for (const event of events) {
    if (event.anomalyType) byType[event.anomalyType]++;
    if (event.severity) bySeverity[event.severity]++;
    if (event.status === "resolved") resolved++;
  }

  const meanTimeToResolve = events.length > 0
    ? events.filter((e) => e.resolutionNotes).reduce((sum, e) => sum + (e.detectedAt.getTime() - new Date().getTime()), 0) / events.length
    : undefined;

  return {
    totalAnomalies: total,
    criticalCount: critical,
    highCount: high,
    mediumCount: medium,
    lowCount: low,
    byType,
    bySeverity,
    resolvedPercentage: total > 0 ? Math.round((resolved / total) * 100) : 100,
    meanTimeToDetect: 0, // calculated at detection time
    meanTimeToResolve,
  };
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "detect";

    if (action === "detect") {
      const metricId = searchParams.get("metricId") || "metrics_001";
      const metricName = searchParams.get("metricName") || "Revenue";
      const currentValue = parseFloat(searchParams.get("currentValue") || "0");
      const historicalStr = searchParams.get("historical");
      const historicalValues = historicalStr
        ? historicalStr.split(",").map((v: string) => parseFloat(v)).filter((v: number) => !isNaN(v))
        : [];
      const upperStr = searchParams.get("upperThreshold");
      const lowerStr = searchParams.get("lowerThreshold");
      const upperThreshold = upperStr ? parseFloat(upperStr) : Infinity;
      const lowerThreshold = lowerStr ? parseFloat(lowerStr) : -Infinity;

      const anomalies = detectAnomalies(metricId, metricName, currentValue, historicalValues, {
        upper: upperThreshold,
        lower: lowerThreshold,
      });
      const stats = getAnomalyStats(anomalies);
      return new Response(JSON.stringify({ anomalies, stats }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "stats") {
      // Return stats from recent anomalies (simulated)
      const stats: AnomalyStats = {
        totalAnomalies: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        byType: { spike: 0, drop: 0, pattern_change: 0, seasonality_shift: 0, threshold_violation: 0, outlier: 0 },
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
        resolvedPercentage: 100,
        meanTimeToDetect: 0,
      };
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: detect anomalies
    const metricId = searchParams.get("metricId") || "metrics_001";
    const metricName = searchParams.get("metricName") || "Revenue";
    const currentValue = parseFloat(searchParams.get("currentValue") || "0");
    const historicalStr = searchParams.get("historical");
    const historicalValues = historicalStr
      ? historicalStr.split(",").map((v: string) => parseFloat(v)).filter((v: number) => !isNaN(v))
      : [currentValue - 10, currentValue - 5, currentValue, currentValue + 5, currentValue + 10];
    const upperStr = searchParams.get("upperThreshold");
    const lowerStr = searchParams.get("lowerThreshold");
    const upperThreshold = upperStr ? parseFloat(upperStr) : Infinity;
    const lowerThreshold = lowerStr ? parseFloat(lowerStr) : -Infinity;

    const anomalies = detectAnomalies(metricId, metricName, currentValue, historicalValues, {
      upper: upperThreshold,
      lower: lowerThreshold,
    });
    const stats = getAnomalyStats(anomalies);
    return new Response(JSON.stringify({ anomalies, stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Anomaly detection error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve anomaly detection data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
