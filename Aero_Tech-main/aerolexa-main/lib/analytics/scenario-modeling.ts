/**
 * Phase 61: Predictive Scenario Modeling with What-If Analysis
 *
 * Advanced predictive scenario modeling engine with what-if analysis, sensitivity
 * analysis, Monte Carlo simulation, and cross-scenario comparison. Builds on the
 * predictive engine (Phase 56) and collaborative workspaces (Phase 59) for
 * enterprise-grade scenario planning and decision support.
 */
import { NextRequest } from "next/server";


import {
  generatePredictiveScore,
} from "./predictive-engine";
import type { MetricType } from "./predictive-engine";

export type Industry = "finance" | "healthcare" | "saas" | "retail" | "manufacturing";

export type ScenarioType = "what_if" | "monte_carlo" | "stress_test" | "best_case" | "worst_case";

export interface ScenarioParameter {
  name: string;
  type: "number" | "percentage" | "boolean";
  current_value: number | boolean;
  min_value?: number;
  max_value?: number;
  step?: number;
  description: string;
}

export interface ScenarioConfig {
  scenario_type: ScenarioType;
  industry: Industry;
  metric: MetricType;
  parameters: ScenarioParameter[];
  horizon: "24h" | "7d" | "30d" | "90d";
  simulation_count?: number; // For Monte Carlo
  confidence_level: number; // 0-100
}

export interface ScenarioResult {
  parameter_name: string;
  parameter_value: number | boolean;
  scenario_type: ScenarioType;
  predicted_value: number;
  confidence: number;
  trend: "up" | "down" | "stable";
  data_points: number;
}

export interface ScenarioComparison {
  baseline_predicted: number;
  baseline_confidence: number;
  scenario_count: number;
  best_scenario: ScenarioResult;
  worst_scenario: ScenarioResult;
  parameter_impacts: {
    parameter: string;
    impact: number;
    percentage_impact: number;
  }[];
}

/** Run a what-if scenario. */
export function runWhatIfScenario(
  config: ScenarioConfig
): {
  scenarios: ScenarioResult[];
  comparison: ScenarioComparison;
} {
  const { parameters, metric, industry, horizon } = config;

  // Start with historical baseline (simulated)
  const historicalCount = 30;
  const historicalValues: number[] = [];
  for (let i = 0; i < historicalCount; i++) {
    const base = Math.random() * 100 + 50;
    historicalValues.push(base);
  }

  const baselineResult = generatePredictiveScore(
    metric,
    industry as Industry,
    historicalValues,
    { metric, industry: industry as Industry, horizon: horizon as any, seasonality: true, trend: true }
  );

  // Apply parameter changes to generate scenarios
  const scenarios: ScenarioResult[] = parameters.map((param) => {
    const modifiedValues = [...historicalValues];
    
    // Apply parameter modification to each data point based on type
    for (let i = 0; i < modifiedValues.length; i++) {
      const currentValue = historicalValues[i] ?? 0;
      if (param.type === "percentage") {
        const pct = Number(param.current_value);
        modifiedValues[i] = Math.max(0, currentValue * (1 + pct / 100));
      } else if (param.type === "number") {
        modifiedValues[i] = Math.max(0, currentValue + Number(param.current_value));
      }
      // boolean type doesn't modify values directly
    }

    // Generate predictive score with modified data
    const modifiedResult = generatePredictiveScore(
      metric,
      industry as Industry,
      modifiedValues,
      { metric, industry: industry as Industry, horizon: horizon as any, seasonality: true, trend: true }
    );

    return {
      parameter_name: param.name,
      parameter_value: param.current_value,
      scenario_type: "what_if",
      predicted_value: modifiedResult.predicted_value,
      confidence: modifiedResult.confidence,
      trend: modifiedResult.trend,
      data_points: modifiedValues.length,
    };
  });

  const [firstScenario, ...remainingScenarios] = scenarios;
  if (!firstScenario) {
    throw new Error("At least one scenario parameter is required.");
  }

  // Generate comparison summary
  const comparison: ScenarioComparison = {
    baseline_predicted: baselineResult.predicted_value,
    baseline_confidence: baselineResult.confidence,
    scenario_count: scenarios.length,
    best_scenario: remainingScenarios.reduce((best, current) =>
      current.predicted_value > best.predicted_value ? current : best
    , firstScenario),
    worst_scenario: remainingScenarios.reduce((worst, current) =>
      current.predicted_value < worst.predicted_value ? current : worst
    , firstScenario),
    parameter_impacts: scenarios.map((s) => ({
      parameter: s.parameter_name,
      impact: s.predicted_value - baselineResult.predicted_value,
      percentage_impact: ((s.predicted_value - baselineResult.predicted_value) / baselineResult.predicted_value) * 100,
    })),
  };

  return { scenarios, comparison };
}

/** Run Monte Carlo simulation. */
export function runMonteCarloSimulation(
  config: Omit<ScenarioConfig, "simulation_count"> & { simulation_count: number }
): {
  distribution: number[];
  statistics: {
    mean: number;
    median: number;
    p25: number;
    p75: number;
    p10: number;
    p90: number;
    std_dev: number;
  };
  probability_of_exceedance: {
    value: number;
    probability: number;
  };
} {
  const { simulation_count, ...baseConfig } = config;
  const historicalCount = 30;
  const historicalValues: number[] = [];
  for (let i = 0; i < historicalCount; i++) {
    historicalValues.push(Math.random() * 100 + 50);
  }

  const baseline = generatePredictiveScore(
    baseConfig.metric,
    baseConfig.industry as Industry,
    historicalValues,
    { ...baseConfig, seasonality: true, trend: true }
  );

  const results: number[] = [];
  for (let i = 0; i < simulation_count; i++) {
    // Generate random parameter perturbations
    const perturbation = (Math.random() - 0.5) * 20; // -10% to +10%
    const perturbedValues = historicalValues.map(v => Math.max(0, v * (1 + perturbation / 100)));
    
    const result = generatePredictiveScore(
      baseConfig.metric,
      baseConfig.industry as Industry,
      perturbedValues,
      { ...baseConfig, seasonality: true, trend: true }
    );
    results.push(result.predicted_value);
  }

  // Calculate statistics
  const sortedResults = [...results].sort((a, b) => a - b);
  const sum = results.reduce((a, b) => a + b, 0);
  const mean = sum / simulation_count;
  const median = sortedResults[Math.floor(simulation_count / 2)] ?? 0;
  const p25 = sortedResults[Math.floor(simulation_count * 0.25)] ?? 0;
  const p75 = sortedResults[Math.floor(simulation_count * 0.75)] ?? 0;
  const p10 = sortedResults[Math.floor(simulation_count * 0.1)] ?? 0;
  const p90 = sortedResults[Math.floor(simulation_count * 0.9)] ?? 0;
  const variance = results.reduce((acc, val) => acc + (val - mean) ** 2, 0) / simulation_count;
  const stdDev = Math.sqrt(variance);

  // Probability of exceeding baseline
  const baselineExceeded = results.filter((r) => r > baseline.predicted_value).length;
  const probability = (baselineExceeded / simulation_count) * 100;

  return {
    distribution: results,
    statistics: {
      mean,
      median,
      p25,
      p75,
      p10,
      p90,
      std_dev: parseFloat(stdDev.toFixed(2)),
    },
    probability_of_exceedance: {
      value: baseline.predicted_value,
      probability: parseFloat(probability.toFixed(1)),
    },
  };
}

/** Get sensitivity analysis. */
export function getSensitivityAnalysis(
  config: ScenarioConfig,
  varyingParameter: ScenarioParameter
): {
  parameter: ScenarioParameter;
  sensitivity_index: number;
  impact_range: [number, number];
  ranked_parameters: (ScenarioParameter & { sensitivity_index: number })[];
} {
  const baseResult = runWhatIfScenario(config);
  const basePredicted = baseResult.scenarios[0]?.predicted_value || 0;

  // Test each parameter at current + step and current - step
  const step = Number(varyingParameter.step ?? 10);
  const baseValue = Number(varyingParameter.current_value);
  const testValues = [baseValue - step, baseValue, baseValue + step];

  const testResults = testValues.map(val => {
    const testParam = {
      ...varyingParameter,
      current_value: val,
    };
    
    // Create modified config with only this parameter varying
    const testConfig = {
      ...config,
      parameters: config.parameters.map(p =>
        p.name === varyingParameter.name ? testParam : p
      ),
    };

    const { scenarios } = runWhatIfScenario(testConfig);
    return scenarios[0]?.predicted_value || basePredicted;
  });

  const lowResult = testResults[0] ?? basePredicted;
  const highResult = testResults[2] ?? basePredicted;
  const sensitivityIndex = ((highResult - lowResult) / 20) * 100; // Normalized index
  const impactRange: [number, number] = [lowResult, highResult];

  // Rank all parameters by sensitivity
  const rankedParameters = config.parameters.map(param => ({
    ...param,
    sensitivity_index: Math.abs((runWhatIfScenario({
      ...config,
      parameters: config.parameters.map(p =>
        p.name === param.name ? { ...p, current_value: Number(p.current_value) + Number(p.step ?? 10) } : p
      ),
    }).scenarios[0]?.predicted_value || basePredicted) - basePredicted) * 100,
  })).sort((a, b) => Math.abs(b.sensitivity_index) - Math.abs(a.sensitivity_index));

  return {
    parameter: varyingParameter,
    sensitivity_index: parseFloat(sensitivityIndex.toFixed(2)),
    impact_range: [parseFloat(impactRange[0].toFixed(2)), parseFloat(impactRange[1].toFixed(2))],
    ranked_parameters: rankedParameters.slice(0, 5), // Top 5
  };
}

/** API route for scenario modeling. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "what-if";

    if (action === "what-if") {
      const industry = searchParams.get("industry") || "saas";
      const metric = searchParams.get("metric") as MetricType || "revenue";
      const horizon = searchParams.get("horizon") || "30d";

      // Build scenario config from query params
      const parameters: ScenarioParameter[] = [];

      // Parse parameter inputs
      for (const key of searchParams.keys()) {
        if (key.startsWith("parameter[")) {
          const paramKey = key.replace("parameter[", "").replace("]", "");
          const value = searchParams.get(key) || "";
          const isPercentage = key.includes("pct") || key.includes("percent");

          parameters.push({
            name: paramKey,
            type: isPercentage ? "percentage" : "number",
            current_value: isPercentage ? parseFloat(value) || 0 : parseFloat(value) || 0,
            description: `What-if parameter: ${paramKey}`,
          });
        }
      }

      // Ensure at least one parameter
      if (parameters.length === 0) {
        parameters.push({
          name: "baseline",
          type: "number",
          current_value: 0,
          description: "Baseline scenario (no changes)",
        });
      }

      const config: ScenarioConfig = {
        scenario_type: "what_if" as ScenarioType,
        industry: industry as Industry,
        metric,
        parameters,
        horizon: horizon as any,
        confidence_level: 95,
      };

      const { scenarios, comparison } = runWhatIfScenario(config);

      return new Response(JSON.stringify({
        industry,
        metric,
        horizon,
        config,
        scenarios,
        comparison,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "monte-carlo") {
      const industry = searchParams.get("industry") || "saas";
      const metric = searchParams.get("metric") as MetricType || "revenue";
      const horizon = searchParams.get("horizon") || "30d";
      const simulationCount = parseInt(searchParams.get("simulations") || "1000", 10);

      const config: ScenarioConfig = {
        scenario_type: "monte_carlo" as ScenarioType,
        industry: industry as Industry,
        metric,
        parameters: [],
        horizon: horizon as any,
        confidence_level: 95,
      };

      const { distribution, statistics, probability_of_exceedance } = runMonteCarloSimulation({
        ...config,
        simulation_count: simulationCount,
      });

      return new Response(JSON.stringify({
        industry,
        metric,
        horizon,
        simulation_count: simulationCount,
        distribution,
        statistics,
        probability_of_exceedance,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "sensitivity") {
      const industry = searchParams.get("industry") || "saas";
      const metric = searchParams.get("metric") as MetricType || "revenue";
      const parameterName = searchParams.get("parameter") || "pricing";

      const config: ScenarioConfig = {
        scenario_type: "what_if" as ScenarioType,
        industry: industry as Industry,
        metric,
        parameters: [
          {
            name: parameterName,
            type: "percentage",
            current_value: 10,
            description: "Pricing sensitivity (percentage change)",
          },
        ],
        horizon: "30d" as any,
        confidence_level: 95,
      };

      const sensitivity = getSensitivityAnalysis(config, {
        name: parameterName,
        type: "percentage",
        current_value: 10,
        description: "Pricing sensitivity",
      });

      return new Response(JSON.stringify({
        industry,
        metric,
        parameter: sensitivity.parameter,
        sensitivity_index: sensitivity.sensitivity_index,
        impact_range: sensitivity.impact_range,
        ranked_parameters: sensitivity.ranked_parameters,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: what-if analysis
    const url = new URL(request.url);
    url.searchParams.set("action", "what-if");
    return GET(new NextRequest(url));
  } catch (error) {
    console.error("Scenario modeling error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to run scenario modeling" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}