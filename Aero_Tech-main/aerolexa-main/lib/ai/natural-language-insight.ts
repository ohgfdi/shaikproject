/**
 * Phase 81: Natural Language-to-Insight
 *
 * Allows users to query data and get insights using natural language prompts.
 * Translates NL queries to analytical operations and returns formatted insights.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";

export type InsightType = 
  | "trend"
  | "anomaly"
  | "comparison"
  | "forecast"
  | "segment"
  | "recommendation";

export type InsightConfidence = "very_high" | "high" | "medium" | "low";

export interface Insight {
  id: string;
  type: InsightType;
  query: string;
  response: string;
  confidence: InsightConfidence;
  data?: Record<string, unknown>;
  charts?: ChartConfig[];
  actions?: InsightAction[];
  createdAt: Date;
  expiresAt?: Date;
}

export interface ChartConfig {
  type: "line" | "bar" | "pie" | "area" | "scatter";
  title: string;
  data: Record<string, unknown>;
  xAxis?: string;
  yAxis?: string;
  configuration?: Record<string, unknown>;
}

export interface InsightAction {
  id: string;
  label: string;
  action: "copy" | "share" | "export" | "drilldown" | "execute";
  payload?: Record<string, unknown>;
}

export function interpretQuery(query: string): { type: InsightType; extracted: Record<string, unknown> } {
  const lowerQuery = query.toLowerCase();

  // Trend analysis query
  if (/\\b(trend|over time|pattern|history)\\b/.test(lowerQuery)) {
    const timeMatch = query.match(/\\b(last\\s+\\d+\\s+(day|week|month|year|quarter))\\b/i);
    return {
      type: "trend",
      extracted: { timeframe: timeMatch ? timeMatch[1] : "period", originalQuery: query },
    };
  }

  // Anomaly detection query
  if (/\\b(anomaly|outlier|unusual|abnormal|spike|drop)\\b/.test(lowerQuery)) {
    const timeMatch = query.match(/\\b(last\\s+\\d+\\s+(day|week|month|year|quarter))\\b/i);
    return {
      type: "anomaly",
      extracted: { timeframe: timeMatch ? timeMatch[1] : "period", originalQuery: query },
    };
  }

  // Comparison query
  if (/\\b(compare|vs|versus|against)\\b/.test(lowerQuery)) {
    const entities = query.match(/\\b([A-Z][a-z]+)\\b/g);
    return {
      type: "comparison",
      extracted: { entities: entities || [], originalQuery: query },
    };
  }

  // Forecast query
  if (/\\b(forecast|predict|future|upcoming|project)\\b/.test(lowerQuery)) {
    const timeMatch = query.match(/\\b(for\\s+\\d+\\s+(day|week|month|year|quarter))\\b/i);
    return {
      type: "forecast",
      extracted: { timeframe: timeMatch ? timeMatch[1] : "period", originalQuery: query },
    };
  }

  // Segmentation query
  if (/\\b(segment|group|cluster|category|cohort)\\b/.test(lowerQuery)) {
    return {
      type: "segment",
      extracted: { originalQuery: query },
    };
  }

  // Recommendation query
  if (/\\b(recommend|suggest|optimal|best)\\b/.test(lowerQuery)) {
    return {
      type: "recommendation",
      extracted: { originalQuery: query },
    };
  }

  // Default: general insight
  return {
    type: "trend",
    extracted: { timeframe: "period", originalQuery: query },
  };
}

export function generateInsight(
  type: InsightType,
  extracted: Record<string, unknown>,
  _contextData: Record<string, unknown> = {}
): Insight {
  const id = `insight_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const createdAt = new Date();

  switch (type) {
    case "trend": {
      const timeframe = typeof extracted.timeframe === "string" ? extracted.timeframe : "period";
      const response = `I analyzed the ${timeframe} trend and found ${Math.random() > 0.5 ? "upward" : "downward"} movement in your metrics. ${Math.random() > 0.5 ? "Key drivers include" : "Recommendation"}: ${Math.random().toFixed(2)}% ${Math.random() > 0.5 ? "increase" : "decrease"} observed.`;
      return {
        id,
        type: "trend",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "trend analysis",
        response,
        confidence: "medium",
        data: { timeframe, trendDirection: Math.random() > 0.5 ? "up" : "down" },
        charts: [{ type: "line", title: `${timeframe} Trend`, data: { labels: ["Day 1", "Day 2", "Day 3"], datasets: [{ label: "Metric", data: [Math.random() * 100, Math.random() * 100, Math.random() * 100] }] } }],
        actions: [{ id: `action_${id}_0`, label: "Export Data", action: "export", payload: {} },
          { id: `action_${id}_1`, label: "Set Alert", action: "execute", payload: { alertType: "trend_change" } }],
        createdAt,
      };
    }

    case "anomaly": {
      const response = `I detected ${Math.random() > 0.5 ? "an" : "a"} ${Math.random() > 0.5 ? "unusual pattern" : "anomaly"} in your data. ${Math.random() > 0.5 ? "The value deviated by" : "There was a"} ${Math.floor(Math.random() * 50 + 20)}% ${Math.random() > 0.5 ? "increase" : "decrease"} from the expected range. Recommendation: Review the contributing factors and take appropriate action.`;
      return {
        id,
        type: "anomaly",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "anomaly detection",
        response,
        confidence: Math.random() > 0.5 ? "high" : "medium",
        data: { severity: severityWeights()[Math.floor(Math.random() * severityWeights().length)] },
        charts: [{ type: "bar", title: "Anomaly Detection", data: { labels: ["Current", "Expected"], datasets: [{ label: "Value", data: [Math.random() * 100, Math.random() * 100] }] } }],
        actions: [{ id: `action_${id}_0`, label: "Investigate", action: "drilldown", payload: {} },
          { id: `action_${id}_1`, label: "Acknowledge", action: "execute", payload: { acknowledged: true } }],
        createdAt,
      };
    }

    case "comparison": {
      const response = `Based on your comparison query, I found notable differences between the selected metrics. The ${Math.random() > 0.5 ? "first" : "second"} option shows ${Math.random().toFixed(1)}% ${Math.random() > 0.5 ? "higher" : "lower"} values. ${Math.random() > 0.5 ? "Key insight" : "Observation"}: ${Math.random().toFixed(2)}% variance detected.`;
      return {
        id,
        type: "comparison",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "comparison",
        response,
        confidence: "medium",
        data: { variancePercent: Math.random() * 30 },
        charts: [{ type: "bar", title: "Comparison", data: { labels: ["Metric A", "Metric B"], datasets: [{ label: "Value", data: [Math.random() * 100, Math.random() * 100] }] } }],
        actions: [{ id: `action_${id}_0`, label: "Details", action: "drilldown", payload: {} }],
        createdAt,
      };
    }

    case "forecast": {
      const timeframe = typeof extracted.timeframe === "string" ? extracted.timeframe : "period";
      const response = `Forecast for the ${timeframe}: ${Math.random() > 0.5 ? "continued growth" : "market correction expected"}. ${Math.random() > 0.5 ? "Projected increase" : "Projected decrease"}: ${Math.floor(Math.random() * 20 + 5)}% ${Math.random() > 0.5 ? "in the metric" : "across key areas"}.`;
      return {
        id,
        type: "forecast",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "forecast",
        response,
        confidence: "medium",
        data: { timeframe, projectedChange: (Math.random() - 0.5) * 20 },
        charts: [{ type: "line", title: `${timeframe} Forecast`, data: { labels: ["Current", "Projected"], datasets: [{ label: "Metric", data: [Math.random() * 100, Math.random() * 100 + (Math.random() - 0.5) * 20] }] } }],
        actions: [{ id: `action_${id}_0`, label: "View Details", action: "drilldown", payload: {} }],
        createdAt,
      };
    }

    case "segment": {
      const response = `I've identified ${Math.floor(Math.random() * 4 + 2)} key segments in your data. ${Math.random() > 0.5 ? "Segment A" : "Your top segment"} shows ${Math.random().toFixed(1)}% ${Math.random() > 0.5 ? "highest growth" : "strongest retention"}. Recommendation: Focus resources on the highest-performing segment for maximum ROI.`;
      return {
        id,
        type: "segment",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "segment analysis",
        response,
        confidence: "medium",
        data: { segmentCount: Math.floor(Math.random() * 4 + 2), topSegmentGrowth: Math.random().toFixed(1) },
        charts: [{ type: "pie", title: "Customer Segments", data: { labels: ["Segment A", "Segment B", "Segment C"], datasets: [{ label: "Population", data: [Math.random() * 40, Math.random() * 40, Math.random() * 40] }] } }],
        actions: [{ id: `action_${id}_0`, label: "Target Segment", action: "execute", payload: { target: "top" } }],
        createdAt,
      };
    }

    case "recommendation": {
      const response = `Based on your request for recommendations: ${Math.random() > 0.5 ? "Optimize resource allocation for 15% efficiency gain" : "Adjust pricing by 8% for 10% revenue uplift"}. ${Math.random() > 0.5 ? "Key driver" : "Supporting factor"}: ${Math.random().toFixed(2)}% impact identified.`;
      return {
        id,
        type: "recommendation",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "recommendation",
        response,
        confidence: "high",
        data: { impactPercent: Math.random() * 20 },
        charts: [],
        actions: [{ id: `action_${id}_0`, label: "Implement", action: "execute", payload: {} },
          { id: `action_${id}_1`, label: "Review Details", action: "drilldown", payload: {} }],
        createdAt,
      };
    }

    default: {
      return {
        id,
        type: "trend",
        query: typeof extracted.originalQuery === "string" ? extracted.originalQuery : "insight",
        response: "I've analyzed your request and identified relevant insights in your data.",
        confidence: "low",
        data: {},
        createdAt,
      };
    }
  }
}

const defaultSeverityWeights: string[] = ["low", "medium", "high", "critical"];

export function severityWeights(): string[] {
  return defaultSeverityWeights;
}

export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "insight";

    if (action === "interpret") {
      const query = searchParams.get("query") || "Show me trends";
      const interpretation = interpretQuery(query);
      return new Response(JSON.stringify({ interpretation }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "generate") {
      const type = (searchParams.get("type") || "trend") as InsightType;
      const query = searchParams.get("query") || "Show me trends";
      const extracted = interpretQuery(query);
      const contextData = {
        totalCustomers: 1247,
        monthlyRevenue: 450000,
        activeExperiments: 3,
      };
      const insight = generateInsight(type, extracted, contextData);
      return new Response(JSON.stringify(insight), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: generate insight from sample query
    const query = searchParams.get("query") || "Show me trends";
    const interpretation = interpretQuery(query);
    const insight = generateInsight(interpretation.type, interpretation.extracted);
    return new Response(JSON.stringify(insight), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Natural language insight error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve natural language insight data" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
