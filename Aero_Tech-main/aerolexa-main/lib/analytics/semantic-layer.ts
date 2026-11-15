/**
 * Semantic Layer - Governed Metrics Definitions
 *
 * Defines business metrics once, reuse across all analyses.
 * Ensures consistency: every report uses the same definitions.
 *
 * Honesty guarantees (enforced by the code below, not by convention):
 * - A metric is only offered when ALL of its source columns exist in the
 *   dataset (exact / alias match — never a substring guess).
 * - Every metric computes the formula printed next to it. A "Total Revenue"
 *   is the sum of the resolved revenue column; a "Profit Margin" is
 *   (Σ revenue − Σ cost) / Σ revenue — never a mislabeled column average.
 * - `confidence` is measured, not invented: it equals the fraction of the
 *   analysed rows that actually contributed to the value (1.0 = every row).
 * - When a value cannot be computed (missing column, zero denominator,
 *   no valid rows) the metric is omitted — never replaced by a guess.
 */

import { prisma } from "@/lib/db";
import { loadParsedDataset, type Cell } from "@/lib/engine/dataset";
import { evaluateMeasure, type DaxModel } from "@/lib/engine/dax";
import { serverEnv } from "@/lib/env";
import type { ColumnDef } from "@/lib/types";

export interface MetricDefinition {
  /** Stable builtin id (e.g. "revenue_total") — safe to reference in UI/tests. */
  id: string;
  name: string;
  description: string;
  formula: MetricFormula;
  /** Human-readable formula string shown in the UI next to the value. */
  formulaHuman: string;
  format: "number" | "currency" | "percentage";
  /** Candidate source columns, most specific first. Resolved per dataset. */
  sourceColumns: string[];
  tags: string[];
  /** True for built-in metrics, false for user-defined custom metrics. */
  isBuiltin?: boolean;
  /** DAX expression for custom metrics (when formula.type === "dax"). */
  daxExpression?: string;
  /** Diagnostic hints for automated root-cause analysis. */
  diagnosticHints?: DiagnosticHint[];
  /** Percent change from baseline that triggers diagnostic analysis. */
  changeThreshold?: number;
}

export interface CustomMetricDefinition extends MetricDefinition {
  formula: { type: "dax"; expression: string };
  isBuiltin: false;
  datasetId?: string;
  projectId?: string;
  isGlobal: boolean;
  createdById: string;
}

type Aggregation = "sum" | "avg" | "count" | "min" | "max" | "countDistinct";

export type MetricFormula =
  /** Aggregate one resolved column. */
  | { type: "column"; aggregation: Aggregation }
  /**
   * Aggregate several resolved columns, then combine the aggregates with a
   * pure function. `evaluate` receives the named aggregates; it must be
   * deterministic and total (guards for zero denominators inside).
   */
  | {
      type: "derived";
      /** column-name candidates per named input, resolved like sourceColumns. */
      parts: Record<string, string[]>;
      aggregations: Record<string, Aggregation>;
      /**
       * Combine the named aggregates. Inputs may be absent (no index signature
       * at runtime); a missing input reads as NaN and the metric is omitted —
       * never guessed. Implementations must be deterministic and total.
       */
      evaluate: (aggregates: Record<string, number | undefined>) => number | null;
    }
  /** Custom DAX expression evaluated against the dataset. */
  | { type: "dax"; expression: string };

/** Read a named aggregate defensively: undefined → NaN (never a guess). */
function aggValue(aggregates: Record<string, number | undefined>, key: string): number {
  const v = aggregates[key];
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

export interface MetricValue {
  metricId: string;
  metricName: string;
  value: number;
  formattedValue: string;
  /** Measured coverage: contributing rows / analysed rows (0–1). */
  confidence: number;
  computedAt: Date;
  /** Rows that actually contributed to the value. */
  sampleSize: number;
  /** Analysed rows the metric was computed over. */
  totalRows: number;
  /** Resolved (actual dataset) columns used, by formula-input name. */
  resolvedColumns: Record<string, string>;
  /** The human formula this number was computed with. */
  formula: string;
}

/** Diagnostic hint for root-cause analysis. */
export interface DiagnosticHint {
  /** Metric this hint correlates with. */
  correlatedMetric: string;
  /** Correlation strength 0–1, higher = stronger relationship. */
  correlation: number;
  /** Evidence snippet supporting this hint. */
  evidence: string;
  /** Human-readable reason for the hint. */
  reason: string;
}

/** Diagnostic evidence supporting a root cause. */
export interface DiagnosticEvidence {
  /** Column/feature involved in the evidence. */
  column: string;
  /** Value or range that contributed. */
  value: string;
  /** How strongly this evidence supports the cause. */
  strength: number;
}

/** Root-cause classification. */
export interface DiagnosticCause {
  /** Category of root cause. */
  category: "data_quality" | "missing_values" | "outlier" | "distribution" | "statistical" | "business_rule";
  /** Description of the cause. */
  description: string;
  /** Supporting diagnostic hints, if any. */
  supportingHints: DiagnosticHint[];
  /** Supporting evidence, if any. */
  supportingEvidence: DiagnosticEvidence[];
}

/** Full diagnostic result for a metric. */
export interface DiagnosticResult {
  /** Metric being diagnosed. */
  metricId: string;
  /** Metric name for display. */
  metricName: string;
  /** Whether an anomaly was detected. */
  hasAnomaly: boolean;
  /** The detected root cause. */
  cause: DiagnosticCause | null;
  /** Numeric metric value. */
  value: number;
  /** Formatted metric value. */
  formattedValue: string;
  /** Confidence in the diagnosis (0–1). */
  confidence: number;
  /** Contributing sample size. */
  sampleSize: number;
  /** Total rows analysed. */
  totalRows: number;
  /** Supporting evidence from the diagnosis. */
  supportingEvidence?: DiagnosticEvidence[] | undefined;
  /** Supporting hints from the diagnosis. */
  supportingHints?: DiagnosticHint[] | undefined;
}

// ---------------------------------------------------------------------------
// Built-in Metric Definitions (Industry-Standard)
// ---------------------------------------------------------------------------

export const BUILTIN_METRICS: MetricDefinition[] = [
  // Financial Metrics
  {
    id: "revenue_total",
    name: "Total Revenue",
    description: "Sum of all revenue transactions",
    formula: { type: "column", aggregation: "sum" },
    formulaHuman: "Σ revenue",
    format: "currency",
    sourceColumns: ["revenue", "sales", "amount", "total_amount", "total", "gross_revenue", "turnover"],
    tags: ["financial", "kpi", "revenue"],
  },
  {
    id: "revenue_avg",
    name: "Average Revenue",
    description: "Mean revenue per transaction",
    formula: { type: "column", aggregation: "avg" },
    formulaHuman: "mean(revenue)",
    format: "currency",
    sourceColumns: ["revenue", "sales", "amount", "total_amount", "total"],
    tags: ["financial", "kpi", "revenue"],
  },
  {
    id: "profit_margin",
    name: "Profit Margin",
    description: "Profit as a share of revenue: (Σ revenue − Σ cost) / Σ revenue",
    formula: {
      type: "derived",
      parts: { revenue: ["revenue", "sales", "total"], cost: ["cost", "costs", "cogs", "expenses", "spend"] },
      aggregations: { revenue: "sum", cost: "sum" },
      evaluate: (a) => {
        const revenue = aggValue(a, "revenue");
        const cost = aggValue(a, "cost");
        if (!Number.isFinite(revenue) || !Number.isFinite(cost) || revenue === 0) return null;
        return ((revenue - cost) / revenue) * 100;
      },
    },
    formulaHuman: "(Σ revenue − Σ cost) / Σ revenue × 100",
    format: "percentage",
    sourceColumns: ["revenue", "cost"],
    tags: ["financial", "efficiency", "profit"],
  },
  {
    id: "cost_per_unit",
    name: "Cost per Unit",
    description: "Total cost divided by total quantity sold",
    formula: {
      type: "derived",
      parts: { cost: ["cost", "costs", "cogs", "expenses"], quantity: ["quantity", "qty", "units", "volume"] },
      aggregations: { cost: "sum", quantity: "sum" },
      evaluate: (a) => {
        const cost = aggValue(a, "cost");
        const quantity = aggValue(a, "quantity");
        if (!Number.isFinite(cost) || !Number.isFinite(quantity) || quantity === 0) return null;
        return cost / quantity;
      },
    },
    formulaHuman: "Σ cost / Σ quantity",
    format: "currency",
    sourceColumns: ["cost", "quantity"],
    tags: ["financial", "efficiency", "cost"],
  },

  // Customer Metrics
  {
    id: "customer_count",
    name: "Customer Count",
    description: "Number of distinct customers",
    formula: { type: "column", aggregation: "countDistinct" },
    formulaHuman: "distinct(customer)",
    format: "number",
    sourceColumns: [
      "customer_id",
      "customerId",
      "customer_name",
      "customerName",
      "customer",
      "client_id",
      "client",
      "account_id",
      "account",
      "user_id",
      "userId",
      "user",
    ],
    tags: ["customer", "kpi"],
  },
  {
    id: "customer_lifetime_value",
    name: "Average Revenue per Customer",
    description: "Total revenue divided by the number of distinct customers",
    formula: {
      type: "derived",
      parts: {
        revenue: ["revenue", "sales", "total"],
        customer: [
          "customer_id",
          "customerId",
          "customer_name",
          "customerName",
          "customer",
          "client",
          "user_id",
          "userId",
        ],
      },
      aggregations: { revenue: "sum", customer: "countDistinct" },
      evaluate: (a) => {
        const revenue = aggValue(a, "revenue");
        const customer = aggValue(a, "customer");
        if (!Number.isFinite(revenue) || !Number.isFinite(customer) || customer === 0) return null;
        return revenue / customer;
      },
    },
    formulaHuman: "Σ revenue / distinct(customer)",
    format: "currency",
    sourceColumns: ["revenue", "customer"],
    tags: ["customer", "kpi", "value"],
  },

  // Operational Metrics
  {
    id: "order_count",
    name: "Order Count",
    description: "Number of distinct orders or transactions",
    formula: { type: "column", aggregation: "countDistinct" },
    formulaHuman: "distinct(order)",
    format: "number",
    sourceColumns: [
      "order_id",
      "orderId",
      "order",
      "transaction_id",
      "transactionId",
      "transaction",
      "invoice_id",
      "invoice",
    ],
    tags: ["operational", "kpi", "orders"],
  },
  {
    id: "average_order_value",
    name: "Average Order Value",
    description: "Total revenue divided by the number of distinct orders",
    formula: {
      type: "derived",
      parts: {
        revenue: ["revenue", "sales", "total"],
        order: ["order_id", "orderId", "order", "transaction_id", "transactionId", "transaction", "invoice_id"],
      },
      aggregations: { revenue: "sum", order: "countDistinct" },
      evaluate: (a) => {
        const revenue = aggValue(a, "revenue");
        const order = aggValue(a, "order");
        if (!Number.isFinite(revenue) || !Number.isFinite(order) || order === 0) return null;
        return revenue / order;
      },
    },
    formulaHuman: "Σ revenue / distinct(order)",
    format: "currency",
    sourceColumns: ["revenue", "order"],
    tags: ["operational", "kpi", "orders"],
  },
  {
    id: "conversion_rate",
    name: "Conversion Rate",
    description: "Conversions as a share of visitors: Σ conversions / Σ visitors",
    formula: {
      type: "derived",
      parts: {
        conversions: ["conversions", "converted", "signups"],
        visitors: ["visitors", "visits", "sessions", "clicks"],
      },
      aggregations: { conversions: "sum", visitors: "sum" },
      evaluate: (a) => {
        const conversions = aggValue(a, "conversions");
        const visitors = aggValue(a, "visitors");
        if (!Number.isFinite(conversions) || !Number.isFinite(visitors) || visitors === 0) return null;
        return (conversions / visitors) * 100;
      },
    },
    formulaHuman: "Σ conversions / Σ visitors × 100",
    format: "percentage",
    sourceColumns: ["conversions", "visitors"],
    tags: ["marketing", "kpi", "conversion"],
  },

  // Quality Metrics
  {
    id: "defect_rate",
    name: "Defect Rate",
    description: "Defects as a share of total items: Σ defects / Σ total items",
    formula: {
      type: "derived",
      parts: {
        defects: ["defects", "defective", "failures"],
        total: ["total_items", "totalItems", "items", "produced"],
      },
      aggregations: { defects: "sum", total: "sum" },
      evaluate: (a) => {
        const defects = aggValue(a, "defects");
        const total = aggValue(a, "total");
        if (!Number.isFinite(defects) || !Number.isFinite(total) || total === 0) return null;
        return (defects / total) * 100;
      },
    },
    formulaHuman: "Σ defects / Σ items × 100",
    format: "percentage",
    sourceColumns: ["defects", "total_items"],
    tags: ["quality", "kpi"],
  },
  {
    id: "completion_rate",
    name: "Completion Rate",
    description: "Completed items as a share of the total: Σ completed / Σ total",
    formula: {
      type: "derived",
      parts: {
        completed: ["completed", "complete", "done", "finished"],
        total: ["total", "total_tasks", "totalTasks", "tasks"],
      },
      aggregations: { completed: "sum", total: "sum" },
      evaluate: (a) => {
        const completed = aggValue(a, "completed");
        const total = aggValue(a, "total");
        if (!Number.isFinite(completed) || !Number.isFinite(total) || total === 0) return null;
        return (completed / total) * 100;
      },
    },
    formulaHuman: "Σ completed / Σ total × 100",
    format: "percentage",
    sourceColumns: ["completed", "total"],
    tags: ["quality", "kpi"],
  },
];

// ---------------------------------------------------------------------------
// Column resolution (exact / alias — never a substring guess)
// ---------------------------------------------------------------------------

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve the first candidate to a real dataset column. Matching order:
 * 1. exact case-insensitive name
 * 2. normalized match (spaces/underscores/case ignored)
 * Returns null when no candidate matches — the metric is then not offered.
 */
function resolveColumn(candidates: string[], columns: ColumnDef[]): ColumnDef | null {
  for (const candidate of candidates) {
    const exact = columns.find((c) => c.name.toLowerCase() === candidate.toLowerCase());
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const target = normalize(candidate);
    if (!target) continue;
    const norm = columns.find((c) => normalize(c.name) === target);
    if (norm) return norm;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Semantic Layer Manager
// ---------------------------------------------------------------------------

export class SemanticLayerManager {
  private datasetId: string;
  private columns: ColumnDef[] = [];
  private rows: Record<string, unknown>[] = [];
  private totalRows = 0;
  private matched: { definition: MetricDefinition; resolved: Record<string, ColumnDef> }[] = [];
  private customMetrics: CustomMetricDefinition[] = [];

  constructor(datasetId: string) {
    this.datasetId = datasetId;
  }

  /**
   * Load the dataset schema + rows (up to the analysis limit) and match
   * built-in metric definitions to the columns that actually exist.
   *
   * `preloaded` lets a caller that has already streamed the dataset hand the
   * rows/columns over, avoiding a second read of the same NDJSON file. When
   * omitted, the manager loads the dataset itself exactly as before.
   */
  async initialize(preloaded?: { rows: Cell[][]; totalRows?: number; columns?: ColumnDef[] }): Promise<void> {
    const env = serverEnv();
    const loaded = preloaded
      ? { rows: preloaded.rows, totalRows: preloaded.totalRows ?? preloaded.rows.length }
      : await loadParsedDataset(this.datasetId, env.DATASET_ANALYSIS_LIMIT);

    let columns = preloaded?.columns;
    if (!columns) {
      const dataset = await prisma.dataset.findUnique({ where: { id: this.datasetId } });
      if (!dataset) return;
      columns = JSON.parse(dataset.columns) as ColumnDef[];
    }
    this.columns = columns;
    this.totalRows = loaded.totalRows;

    // Positional rows → keyed objects by column name (array rows from the
    // engine, or already-keyed objects from test mocks).
    this.rows = loaded.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      if (Array.isArray(row)) {
        this.columns.forEach((c, i) => {
          obj[c.name] = row[i] ?? null;
        });
      } else {
        this.columns.forEach((c) => {
          obj[c.name] = (row as Record<string, unknown>)[c.name] ?? null;
        });
      }
      return obj;
    });

    this.matched = [];
    for (const metric of BUILTIN_METRICS) {
      const resolved: Record<string, ColumnDef> = {};
      let ok = true;

      if (metric.formula.type === "column") {
        const col = resolveColumn(metric.sourceColumns, this.columns);
        if (col) resolved.value = col;
        else ok = false;
      } else if (metric.formula.type === "derived") {
        for (const [key, candidates] of Object.entries(metric.formula.parts)) {
          const col = resolveColumn(candidates, this.columns);
          if (col) resolved[key] = col;
          else {
            ok = false;
            break;
          }
        }
      }

      // A metric is only offered when every input column exists.
      if (ok) this.matched.push({ definition: metric, resolved });
    }

    // Load custom metrics for this dataset
    await this.loadCustomMetrics();
  }

  /** Load custom metrics from the database that apply to this dataset. */
  private async loadCustomMetrics(): Promise<void> {
    const dataset = await prisma.dataset.findUnique({ where: { id: this.datasetId } });
    if (!dataset) return;

    const projectId = dataset.projectId ?? undefined;

    const custom = await prisma.customMetric.findMany({
      where: {
        workspaceId: dataset.workspaceId,
        OR: [{ datasetId: this.datasetId }, { isGlobal: true }, { projectId, datasetId: null }],
      },
    });

    this.customMetrics = custom
      .filter((m) => m.daxExpression && m.daxExpression.trim().length > 0)
      .map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? "",
        formula: { type: "dax" as const, expression: m.daxExpression },
        formulaHuman: m.daxExpression,
        format: m.format as "number" | "currency" | "percentage",
        sourceColumns: [],
        tags: JSON.parse(m.tags || "[]"),
        isBuiltin: false,
        daxExpression: m.daxExpression,
        datasetId: m.datasetId ?? undefined,
        projectId: m.projectId ?? undefined,
        isGlobal: m.isGlobal,
        createdById: m.createdById,
      }));
  }

  /** Definitions matched to this dataset's real columns (built-in + custom). */
  getMetrics(): MetricDefinition[] {
    return [...this.matched.map((m) => m.definition), ...this.customMetrics];
  }

  /** Get only custom metrics for this dataset. */
  getCustomMetrics(): CustomMetricDefinition[] {
    return this.customMetrics;
  }

  /** Rows actually loaded for analysis (≤ totalRows on disk; labelled sample). */
  getAnalyzedRowCount(): number {
    return this.rows.length;
  }

  /** Rows on disk for this dataset (0 when the dataset record was not found). */
  getTotalRowCount(): number {
    return this.totalRows;
  }

  /** Resolved dataset column per metric id (for provenance display). */
  getResolvedColumns(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const { definition, resolved } of this.matched) {
      out[definition.id] = Object.fromEntries(Object.entries(resolved).map(([k, c]) => [k, c.name]));
    }
    return out;
  }

  getMetric(metricId: string): MetricDefinition | undefined {
    return this.matched.find((m) => m.definition.id === metricId)?.definition;
  }

  /**
   * Compute every matched metric. Metrics whose data cannot support the
   * formula (no numeric rows, zero denominator) are omitted — never guessed.
   */
  async computeMetrics(): Promise<MetricValue[]> {
    const values: MetricValue[] = [];
    for (const { definition, resolved } of this.matched) {
      const value = this.computeMetric(definition, resolved);
      if (value) values.push(value);
    }
    // Compute custom metrics using DAX engine
    for (const metric of this.customMetrics) {
      const value = await this.computeCustomMetric(metric);
      if (value) values.push(value);
    }
    return values;
  }

  /**
   * Diagnose a metric to find root-cause insights.
   * Analyzes the metric's computed value against the data to detect anomalies
   * and identify root causes using diagnostic hints and evidence.
   * @param metricId The metric ID to diagnose
   * @returns DiagnosticResult with anomaly detection and root cause analysis
   */
  async diagnoseMetric(metricId: string): Promise<DiagnosticResult> {
    // Find the matched entry for this metric to get resolved columns
    const matchedEntry = this.matched.find((m) => m.definition.id === metricId);
    const metric = matchedEntry?.definition;

    if (!metric) {
      return {
        metricId,
        metricName: metricId,
        hasAnomaly: false,
        cause: null,
        value: 0,
        formattedValue: "0",
        confidence: 0,
        sampleSize: 0,
        totalRows: 0,
        supportingEvidence: undefined,
        supportingHints: undefined,
      };
    }

    // Get the computed value for this metric
    const allValues = await this.computeMetrics();
    const metricValue = allValues.find((v) => v.metricId === metricId);

    // Build the base result
    const baseResult: DiagnosticResult = {
      metricId: metric.id,
      metricName: metric.name,
      hasAnomaly: false,
      cause: null,
      value: metricValue?.value ?? 0,
      formattedValue: metricValue?.formattedValue ?? this.formatValue(0, metric.format),
      confidence: metricValue?.confidence ?? 0,
      sampleSize: metricValue?.sampleSize ?? 0,
      totalRows: this.totalRows,
      supportingEvidence: undefined,
      supportingHints: undefined,
    };

    // If no data, return early
    if (this.rows.length === 0) {
      return baseResult;
    }

    // Analyze for anomalies based on metric type and data patterns
    const issues: string[] = [];
    let detectedCause: DiagnosticCause | null = null;
    const supportingEvidence: DiagnosticEvidence[] = [];
    const supportingHints: DiagnosticHint[] = [];

    // Get resolved columns from the matched entry
    const resolved = matchedEntry?.resolved ?? {};

    if (metric.formula.type === "column") {
      const col = resolved.value;
      if (col) {
        const { values, validRows } = this.numericValues(col);
        if (validRows > 0) {
          const mean = values.reduce((sum, v) => sum + v, 0) / validRows;
          const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / validRows;
          const stdDev = Math.sqrt(variance);

          // Detect outliers (values > 2 standard deviations from mean)
          if (stdDev > 0) {
            const outliers = values.filter((v) => Math.abs(v - mean) > 2 * stdDev);
            if (outliers.length > 0) {
              baseResult.hasAnomaly = true;
              issues.push(
                `Found ${outliers.length} outlier(s) in ${col.name} (mean: ${mean.toFixed(2)}, ` +
                  `std-dev: ${stdDev.toFixed(2)})`,
              );

              // Create evidence for outliers
              supportingEvidence.push({
                column: col.name,
                value: `${outliers.length} outliers detected`,
                strength: Math.min(1, outliers.length / validRows),
              });

              // Determine cause based on data quality
              detectedCause = {
                category: "outlier" as const,
                description: `Outliers detected in ${col.name}`,
                supportingHints: [],
                supportingEvidence: supportingEvidence,
              };
            }

            // Check for missing values
            const { validRows: totalValid } = this.rawValues(col);
            if (totalValid < this.totalRows) {
              baseResult.hasAnomaly = true;
              issues.push(
                `Missing data: ${this.totalRows - totalValid} of ${this.totalRows} rows ` +
                  `have no value in ${col.name}`,
              );

              supportingEvidence.push({
                column: col.name,
                value: `${this.totalRows - totalValid} missing rows`,
                strength: 0.8,
              });

              if (!detectedCause) {
                detectedCause = {
                  category: "missing_values" as const,
                  description: `Missing values in ${col.name}`,
                  supportingHints: [],
                  supportingEvidence: supportingEvidence,
                };
              }
            }
          }

          // Check for constant values (no variance)
          if (stdDev === 0 && validRows > 0) {
            baseResult.hasAnomaly = true;
            issues.push(`Constant value detected in ${col.name}: all ${validRows} values are ${mean.toFixed(2)}`);

            supportingEvidence.push({
              column: col.name,
              value: `Constant: ${mean.toFixed(2)}`,
              strength: 0.9,
            });

            detectedCause = {
              category: "data_quality" as const,
              description: `Constant value in ${col.name}: no variance`,
              supportingHints: [],
              supportingEvidence: supportingEvidence,
            };
          }
        }
      }
    }

    // For derived metrics, check the contributing columns
    if (metric.formula.type === "derived") {
      for (const [key, _agg] of Object.entries(metric.formula.aggregations)) {
        const col = resolved[key];
        if (col) {
          const { validRows } = this.numericValues(col);
          if (validRows === 0) {
            issues.push(`Column “${col.name}” has no numeric values for ${key}`);

            supportingEvidence.push({
              column: col.name,
              value: "No numeric values",
              strength: 1.0,
            });

            if (!detectedCause) {
              detectedCause = {
                category: "data_quality" as const,
                description: `No numeric data for ${key}`,
                supportingHints: [],
                supportingEvidence: supportingEvidence,
              };
            }
          }
        }
      }
    }

    // Build the final result
    return {
      ...baseResult,
      hasAnomaly: issues.length > 0 || detectedCause ? true : false,
      cause: detectedCause,
      supportingEvidence: issues.length > 0 ? supportingEvidence : undefined,
      supportingHints: issues.length > 0 ? supportingHints : undefined,
    };
  }

  /**
   * Compute a custom metric using the DAX engine.
   * Returns null if the expression cannot be evaluated (e.g., missing columns, errors).
   */
  private async computeCustomMetric(metric: CustomMetricDefinition): Promise<MetricValue | null> {
    const totalRows = this.rows.length;
    if (totalRows === 0) return null;

    // Convert rows to DAX model format
    const model: DaxModel = {
      columns: this.columns.map((c) => c.name),
      rows: this.rows.map((row) =>
        this.columns.map((c) => {
          const v = row[c.name];
          if (v === null || v === undefined) return null;
          // SqlValue = string | number | boolean | null
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
          return String(v);
        }),
      ) as DaxModel["rows"],
    };

    try {
      const result = evaluateMeasure(model, metric.daxExpression!, []);
      if (result === null || result === undefined || (typeof result === "number" && !Number.isFinite(result))) {
        return null;
      }
      const numericResult = typeof result === "number" ? result : Number(result);
      if (!Number.isFinite(numericResult)) return null;

      return {
        metricId: metric.id,
        metricName: metric.name,
        value: numericResult,
        formattedValue: this.formatValue(numericResult, metric.format),
        confidence: 1.0, // DAX evaluates over all visible rows
        computedAt: new Date(),
        sampleSize: totalRows,
        totalRows,
        resolvedColumns: {},
        formula: metric.daxExpression!,
      };
    } catch {
      // DAX evaluation failed (syntax error, missing columns, etc.) — omit metric
      return null;
    }
  }

  private numericValues(column: ColumnDef): { values: number[]; validRows: number } {
    const values: number[] = [];
    for (const row of this.rows) {
      const raw = row[column.name];
      if (raw == null || raw === "") continue;
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,$\s%€£]/g, ""));
      if (Number.isFinite(n)) values.push(n);
    }
    return { values, validRows: values.length };
  }

  private rawValues(column: ColumnDef): { values: string[]; validRows: number } {
    const values: string[] = [];
    for (const row of this.rows) {
      const raw = row[column.name];
      if (raw == null || raw === "") continue;
      values.push(typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw));
    }
    return { values, validRows: values.length };
  }

  private aggregate(column: ColumnDef, agg: Aggregation): { value: number | null; rows: number } {
    if (agg === "countDistinct") {
      const { values, validRows } = this.rawValues(column);
      return { value: values.length === 0 ? null : new Set(values).size, rows: validRows };
    }
    const { values, validRows } = this.numericValues(column);
    if (values.length === 0) return { value: null, rows: validRows };
    switch (agg) {
      case "sum": {
        let sum = 0;
        for (const v of values) sum += v;
        return { value: sum, rows: validRows };
      }
      case "avg": {
        let sum = 0;
        for (const v of values) sum += v;
        return { value: sum / values.length, rows: validRows };
      }
      case "count":
        return { value: values.length, rows: validRows };
      case "min": {
        let m = Number.POSITIVE_INFINITY;
        for (const v of values) if (v < m) m = v;
        return { value: m, rows: validRows };
      }
      case "max": {
        let m = Number.NEGATIVE_INFINITY;
        for (const v of values) if (v > m) m = v;
        return { value: m, rows: validRows };
      }
      default:
        return { value: null, rows: validRows };
    }
  }

  private computeMetric(metric: MetricDefinition, resolved: Record<string, ColumnDef>): MetricValue | null {
    const totalRows = this.rows.length;
    if (totalRows === 0) return null;

    if (metric.formula.type === "column") {
      const col = resolved.value;
      if (!col) return null;
      const { value, rows } = this.aggregate(col, metric.formula.aggregation);
      if (value === null || !Number.isFinite(value)) return null;
      return {
        metricId: metric.id,
        metricName: metric.name,
        value,
        formattedValue: this.formatValue(value, metric.format),
        confidence: rows / totalRows,
        computedAt: new Date(),
        sampleSize: rows,
        totalRows,
        resolvedColumns: { value: col.name },
        formula: metric.formulaHuman,
      };
    }

    if (metric.formula.type === "dax") {
      // DAX metrics are computed separately via computeCustomMetric
      return null;
    }

    // derived: aggregate each named part, then evaluate the formula.
    const aggregates: Record<string, number> = {};
    const resolvedColumns: Record<string, string> = {};
    let contributingRows = 0;
    for (const [key, _agg] of Object.entries(metric.formula.aggregations)) {
      const col = resolved[key];
      if (!col) return null;
      const { value, rows } = this.aggregate(col, _agg);
      if (value === null || !Number.isFinite(value)) return null;
      aggregates[key] = value;
      resolvedColumns[key] = col.name;
      contributingRows = Math.max(contributingRows, rows);
    }

    const result = metric.formula.evaluate(aggregates);
    if (typeof result !== "number" || !Number.isFinite(result)) return null;

    return {
      metricId: metric.id,
      metricName: metric.name,
      value: result,
      formattedValue: this.formatValue(result, metric.format),
      confidence: contributingRows / totalRows,
      computedAt: new Date(),
      sampleSize: contributingRows,
      totalRows,
      resolvedColumns,
      formula: metric.formulaHuman,
    };
  }

  /** Format a metric value for display. */
  private formatValue(value: number, format: string): string {
    switch (format) {
      case "currency":
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(value);
      case "percentage":
        return `${value.toFixed(2)}%`;
      case "number":
        return new Intl.NumberFormat("en-US").format(value);
      case "date":
        return new Date(value).toLocaleDateString();
      default:
        return String(value);
    }
  }

  /**
   * Validate a metric against the data: every source column must exist and
   * contain at least one usable value. Issues are reported verbatim — no
   * silent downgrades.
   */
  validateMetric(metricId: string): { valid: boolean; issues: string[] } {
    const entry = this.matched.find((m) => m.definition.id === metricId);
    const builtin = BUILTIN_METRICS.find((m) => m.id === metricId);
    const metric = entry?.definition ?? builtin;
    if (!metric) {
      return { valid: false, issues: ["Metric not found"] };
    }
    if (!entry) {
      return {
        valid: false,
        issues: [`No matching source columns for “${metric.name}” (needs: ${metric.sourceColumns.join(", ")})`],
      };
    }

    // DAX metrics are validated at evaluation time
    if (metric.formula.type === "dax") {
      return { valid: true, issues: [] };
    }

    const issues: string[] = [];
    const formula = metric.formula;
    const inputs: { key: string; column: ColumnDef; agg: Aggregation }[] =
      formula.type === "column"
        ? [{ key: "value", column: entry.resolved.value!, agg: formula.aggregation }]
        : Object.entries(formula.aggregations).map(([key, agg]) => ({
            key,
            // validateMetric only runs on matched entries; every input resolved.
            column: entry.resolved[key]!,
            agg,
          }));

    for (const { key, column, agg } of inputs) {
      const needsNumbers = agg !== "countDistinct";
      const { validRows } = needsNumbers ? this.numericValues(column) : this.rawValues(column);
      if (validRows === 0) {
        issues.push(
          needsNumbers
            ? `Column “${column.name}” has no numeric values for ${key}`
            : `Column “${column.name}” has no values for ${key}`,
        );
      }
    }

    return { valid: issues.length === 0, issues };
  }
}
