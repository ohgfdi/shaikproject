/**
 * Executive Summary Generator
 *
 * Generates real, data-driven executive summaries from uploaded datasets.
 * No hallucination: every claim is backed by actual computed statistics.
 *
 * Honesty guarantees:
 * - Every number comes from the loaded rows (never a "typical" value).
 * - NaN/Infinity guards on all aggregations; empty columns are skipped, and
 *   the section states what was skipped.
 * - Coverage is explicit: `analyzedRows` vs `totalRows` is surfaced in
 *   metadata, and a sampled run is labelled in metadata + key findings.
 * - Trend direction comes from a period-bucketed comparison (first vs second
 *   half by period means), never from arbitrary row halves.
 */

import { prisma } from "@/lib/db";
import { loadParsedDataset, type Cell } from "@/lib/engine/dataset";
import { serverEnv } from "@/lib/env";
import type { ColumnDef } from "@/lib/types";

export interface SummarySection {
  title: string;
  content: string;
  confidence: number; // 0-1
  evidence: string[]; // Supporting data points
  dataPoints?: Record<string, unknown>[];
}

export interface ExecutiveSummary {
  datasetId: string;
  datasetName: string;
  generatedAt: Date;
  sections: SummarySection[];
  keyFindings: string[];
  recommendations: string[];
  limitations: string[];
  metadata: {
    totalRows: number;
    analyzedRows: number;
    sampled: boolean;
    totalColumns: number;
    timeRange?: { start: string; end: string };
    dataQuality: number; // 0-1 score
  };
}

/**
 * Generate a complete executive summary from a dataset
 */
export async function generateExecutiveSummary(
  datasetId: string,
  options?: {
    maxSections?: number;
    includeRecommendations?: boolean;
    targetAudience?: "executive" | "analyst" | "technical";
  },
): Promise<ExecutiveSummary> {
  const env = serverEnv();
  const limit = env.DATASET_ANALYSIS_LIMIT;

  // Load the real dataset
  const loaded = await loadParsedDataset(datasetId, limit);
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });

  if (!dataset) {
    throw new Error(`Dataset ${datasetId} not found`);
  }

  const columns: ColumnDef[] = JSON.parse(dataset.columns);
  // Positional rows → keyed objects by column name for readable section text.
  const rows = toKeyedRows(loaded.rows, columns);
  const totalRows = loaded.totalRows;
  const analyzedRows = rows.length;
  const sampled = totalRows > analyzedRows;

  if (analyzedRows === 0) {
    throw new Error("This dataset has no rows available to analyse. Re-upload the file or check the dataset status.");
  }

  // Generate sections based on actual data analysis
  const sections: SummarySection[] = [];

  // 1. Dataset Overview
  sections.push(generateOverviewSection(dataset.name, columns, analyzedRows, totalRows, sampled));

  // 2. Data Quality Assessment
  sections.push(generateDataQualitySection(columns, rows));

  // 3. Key Metrics Analysis
  const numericColumns = columns.filter((c) => c.type === "number");
  if (numericColumns.length > 0) {
    sections.push(generateMetricsSection(numericColumns, rows));
  }

  // 4. Categorical Analysis
  const categoricalColumns = columns.filter((c) => c.type === "string");
  if (categoricalColumns.length > 0) {
    sections.push(generateCategoricalSection(categoricalColumns, rows));
  }

  // 5. Temporal Analysis (if date columns exist)
  const dateColumns = columns.filter((c) => c.type === "date");
  if (dateColumns.length > 0) {
    sections.push(generateTemporalSection(dateColumns, numericColumns, rows));
  }

  // 6. Anomalies and Outliers
  sections.push(generateAnomaliesSection(numericColumns, rows));

  // Limit sections if requested
  const maxSections = options?.maxSections ?? 10;
  const trimmedSections = sections.slice(0, maxSections);

  // Generate key findings (honest, evidence-backed)
  const keyFindings = generateKeyFindings(trimmedSections, analyzedRows, totalRows, sampled);

  // Generate recommendations (data-driven, not speculative)
  const recommendations =
    options?.includeRecommendations !== false ? generateRecommendations(trimmedSections, analyzedRows) : [];

  // Identify limitations
  const limitations = generateLimitations(columns, rows, totalRows, sampled, analyzedRows);

  // Calculate data quality score
  const dataQuality = calculateDataQualityScore(columns, rows);

  // Detect time range
  const timeRange = detectTimeRange(dateColumns, rows);

  return {
    datasetId,
    datasetName: dataset.name,
    generatedAt: new Date(),
    sections: trimmedSections,
    keyFindings,
    recommendations,
    limitations,
    metadata: {
      totalRows,
      analyzedRows,
      sampled,
      totalColumns: columns.length,
      timeRange,
      dataQuality,
    },
  };
}

// ---------------------------------------------------------------------------
// Section Generators (All produce real, computed output)
// ---------------------------------------------------------------------------

function generateOverviewSection(
  name: string,
  columns: ColumnDef[],
  analyzedRows: number,
  totalRows: number,
  sampled: boolean,
): SummarySection {
  const columnTypes = columns.reduce(
    (acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const typeSummary = Object.entries(columnTypes)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  const samplingNote = sampled
    ? ` Statistics below are computed on the first ${analyzedRows.toLocaleString()} rows (labelled sample of ${totalRows.toLocaleString()}).`
    : "";

  return {
    title: "Dataset Overview",
    content: `"${name}" contains ${totalRows.toLocaleString()} rows across ${columns.length} columns (${typeSummary}).${samplingNote}`,
    confidence: 1.0,
    evidence: [
      `Total rows: ${totalRows.toLocaleString()}`,
      `Analyzed rows: ${analyzedRows.toLocaleString()}${sampled ? " (sampled)" : " (full)"}`,
      `Column count: ${columns.length}`,
      `Column types: ${typeSummary}`,
    ],
  };
}

function generateDataQualitySection(columns: ColumnDef[], rows: Record<string, unknown>[]): SummarySection {
  const issues: string[] = [];
  let totalMissing = 0;

  for (const col of columns) {
    const missingCount = rows.filter((r) => r[col.name] == null || r[col.name] === "").length;
    const missingPercent = (missingCount / rows.length) * 100;

    if (missingPercent > 10) {
      issues.push(`${col.name}: ${missingPercent.toFixed(1)}% missing`);
    }
    totalMissing += missingCount;
  }

  const qualityScore = 1 - totalMissing / (rows.length * columns.length);
  const qualityLabel =
    qualityScore > 0.95 ? "excellent" : qualityScore > 0.85 ? "good" : qualityScore > 0.7 ? "fair" : "poor";

  return {
    title: "Data Quality Assessment",
    content: `Data quality is ${qualityLabel} (${(qualityScore * 100).toFixed(1)}% complete). ${
      issues.length > 0
        ? `Found ${issues.length} column(s) with significant missing data: ${issues.join("; ")}.`
        : "No significant data quality issues detected."
    }`,
    confidence: 0.95,
    evidence: [
      `Quality score: ${(qualityScore * 100).toFixed(1)}%`,
      `Columns with issues: ${issues.length}`,
      `Total missing values: ${totalMissing.toLocaleString()}`,
    ],
  };
}

function generateMetricsSection(numericColumns: ColumnDef[], rows: Record<string, unknown>[]): SummarySection {
  const metrics: string[] = [];
  const evidence: string[] = [];
  let skipped = 0;

  for (const col of numericColumns.slice(0, 5)) {
    // Limit to top 5
    const values = rows
      .map((r) => r[col.name])
      .filter((v) => v != null && v !== "")
      .map((v) => Number(String(v).replace(/[,$\s%€£]/g, "")))
      .filter((v) => Number.isFinite(v));

    if (values.length === 0) {
      skipped++;
      continue;
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

    metrics.push(
      `${col.name}: avg=${avg.toFixed(2)}, median=${median.toFixed(2)}, range=[${min.toFixed(2)}, ${max.toFixed(2)}] (${values.length} valid of ${rows.length})`,
    );
    evidence.push(`${col.name}: ${values.length} valid values, sum=${sum.toFixed(2)}`);
  }

  if (metrics.length === 0) {
    return {
      title: "Key Metrics Analysis",
      content: `${numericColumns.length} column(s) are typed as numbers but contain no parseable numeric values, so no metric statistics could be computed.`,
      confidence: 0.5,
      evidence: [`Numeric columns: ${numericColumns.map((c) => c.name).join(", ")}`],
    };
  }

  return {
    title: "Key Metrics Analysis",
    content: `Analyzed ${numericColumns.length} numeric column(s):\n${metrics
      .map((m) => `- ${m}`)
      .join("\n")}${skipped > 0 ? `\n(${skipped} numeric column(s) skipped — no parseable values.)` : ""}`,
    confidence: 1.0,
    evidence,
  };
}

function generateCategoricalSection(categoricalColumns: ColumnDef[], rows: Record<string, unknown>[]): SummarySection {
  const insights: string[] = [];

  for (const col of categoricalColumns.slice(0, 3)) {
    // Limit to top 3
    const counts = new Map<string, number>();
    for (const row of rows) {
      const raw = row[col.name];
      const val = raw == null || raw === "" ? "(missing)" : String(raw);
      counts.set(val, (counts.get(val) || 0) + 1);
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topValues = sorted.slice(0, 3).map(([val, count]) => `"${val}" (${count})`);
    const uniqueCount = counts.size;

    insights.push(`${col.name}: ${uniqueCount} unique values. Top: ${topValues.join(", ")}`);
  }

  return {
    title: "Categorical Analysis",
    content: `Analyzed ${categoricalColumns.length} categorical column(s):\n${insights
      .map((i) => `- ${i}`)
      .join("\n")}`,
    confidence: 0.9,
    evidence: insights,
  };
}

function generateTemporalSection(
  dateColumns: ColumnDef[],
  numericColumns: ColumnDef[],
  rows: Record<string, unknown>[],
): SummarySection {
  const insights: string[] = [];

  for (const dateCol of dateColumns.slice(0, 2)) {
    const parseDate = (r: Record<string, unknown>): Date | null => {
      const raw = r[dateCol.name];
      if (raw == null || raw === "") return null;
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const dated = rows
      .map((r) => ({ row: r, date: parseDate(r) }))
      .filter((d): d is { row: Record<string, unknown>; date: Date } => d.date !== null);
    if (dated.length === 0) continue;

    dated.sort((a, b) => a.date.getTime() - b.date.getTime());
    const firstDate = dated[0]!.date;
    const lastDate = dated[dated.length - 1]!.date;
    const start = firstDate.toISOString().split("T")[0];
    const end = lastDate.toISOString().split("T")[0];
    const spanDays = Math.ceil((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));

    insights.push(`${dateCol.name}: ${start} to ${end} (${spanDays} days, ${dated.length} dated rows)`);

    // Period-bucketed trend: compare the mean of the FIRST half of months
    // against the mean of the SECOND half — bucketed by period, not row halves.
    if (numericColumns.length > 0 && numericColumns[0]) {
      const trendCol = numericColumns[0];
      const monthly = new Map<string, { sum: number; count: number }>();
      for (const { row, date } of dated) {
        const raw = row[trendCol.name];
        if (raw == null || raw === "") continue;
        const v = Number(String(raw).replace(/[,$\s%€£]/g, ""));
        if (!Number.isFinite(v)) continue;
        const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
        const cur = monthly.get(key) ?? { sum: 0, count: 0 };
        cur.sum += v;
        cur.count += 1;
        monthly.set(key, cur);
      }

      const keys = [...monthly.keys()].sort();
      if (keys.length >= 2) {
        const half = Math.floor(keys.length / 2);
        const firstKeys = keys.slice(0, half);
        const secondKeys = keys.slice(half);
        const avgOf = (ks: string[]): number | null => {
          if (ks.length === 0) return null;
          let sum = 0;
          let n = 0;
          for (const k of ks) {
            const b = monthly.get(k);
            if (!b || b.count === 0) continue;
            sum += b.sum / b.count; // period mean
            n += 1;
          }
          return n === 0 ? null : sum / n;
        };
        const avgFirst = avgOf(firstKeys);
        const avgSecond = avgOf(secondKeys);
        if (avgFirst !== null && avgSecond !== null && Number.isFinite(avgFirst) && avgFirst !== 0) {
          const change = ((avgSecond - avgFirst) / Math.abs(avgFirst)) * 100;
          insights.push(
            `${trendCol.name}: ${change > 0 ? "increasing" : change < 0 ? "decreasing" : "flat"} monthly mean (${change > 0 ? "+" : ""}${change.toFixed(1)}% from the first ${firstKeys.length} to the last ${secondKeys.length} months)`,
          );
        }
      }
    }
  }

  return {
    title: "Temporal Analysis",
    content:
      insights.length > 0
        ? `Time-based analysis:\n${insights.map((i) => `- ${i}`).join("\n")}`
        : "Date columns exist but none contained parseable dates, so no temporal patterns could be computed.",
    confidence: 0.85,
    evidence: insights,
  };
}

function generateAnomaliesSection(numericColumns: ColumnDef[], rows: Record<string, unknown>[]): SummarySection {
  const anomalies: string[] = [];

  for (const col of numericColumns.slice(0, 3)) {
    const values = rows
      .map((r) => r[col.name])
      .filter((v) => v != null && v !== "")
      .map((v) => Number(String(v).replace(/[,$\s%€£]/g, "")))
      .filter((v) => Number.isFinite(v));

    if (values.length < 10) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);
    if (!Number.isFinite(stdDev) || stdDev === 0) continue;

    const outlierThreshold = 3; // 3 standard deviations
    const outliers = values.filter((v) => Math.abs(v - mean) > outlierThreshold * stdDev);

    if (outliers.length > 0) {
      anomalies.push(`${col.name}: ${outliers.length} outlier(s) detected (>3σ from mean)`);
    }
  }

  return {
    title: "Anomalies and Outliers",
    content:
      anomalies.length > 0
        ? `Detected potential anomalies:\n${anomalies.map((a) => `- ${a}`).join("\n")}`
        : "No significant anomalies detected using 3-sigma threshold.",
    confidence: 0.8,
    evidence: anomalies,
  };
}

// ---------------------------------------------------------------------------
// Key Findings Generator (Evidence-Backed)
// ---------------------------------------------------------------------------

function generateKeyFindings(
  sections: SummarySection[],
  analyzedRows: number,
  totalRows: number,
  sampled: boolean,
): string[] {
  const findings: string[] = [];

  if (sampled) {
    findings.push(
      `Computed on the first ${analyzedRows.toLocaleString()} of ${totalRows.toLocaleString()} rows — labelled sample, not the full dataset`,
    );
  }

  // Extract high-confidence findings
  for (const section of sections) {
    if (section.confidence >= 0.9 && section.evidence.length > 0) {
      findings.push(`[${section.title}] ${section.evidence[0]}`);
    }
  }

  // Add data volume finding
  if (totalRows >= 10000) {
    findings.push(
      `Dataset contains substantial data (${totalRows.toLocaleString()} rows) enabling statistical significance`,
    );
  } else if (totalRows < 100) {
    findings.push(`Limited data volume (${totalRows.toLocaleString()} rows) — interpret results with caution`);
  }

  return findings.slice(0, 5); // Limit to top 5
}

// ---------------------------------------------------------------------------
// Recommendations Generator (Data-Driven)
// ---------------------------------------------------------------------------

function generateRecommendations(sections: SummarySection[], analyzedRows: number): string[] {
  const recommendations: string[] = [];

  // Data quality recommendations
  const qualitySection = sections.find((s) => s.title === "Data Quality Assessment");
  if (qualitySection && qualitySection.confidence < 0.9) {
    recommendations.push("Address data quality issues before drawing conclusions");
  }

  // Volume recommendations
  if (analyzedRows < 1000) {
    recommendations.push("Consider collecting more data for statistical robustness");
  }

  // Analysis recommendations
  recommendations.push("Run detailed analysis on key metrics identified in this summary");
  recommendations.push("Validate findings with domain experts");

  return recommendations.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Limitations Generator (Honest)
// ---------------------------------------------------------------------------

function generateLimitations(
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
  totalRows: number,
  sampled: boolean,
  analyzedRows: number,
): string[] {
  const limitations: string[] = [];

  if (sampled) {
    limitations.push(
      `Analysis covers the first ${analyzedRows.toLocaleString()} of ${totalRows.toLocaleString()} rows (server analysis limit) — late-file rows are not reflected`,
    );
  }

  if (totalRows < 100) {
    limitations.push("Small sample size may limit statistical significance");
  }

  const missingColumns = columns.filter((c) => {
    const missingCount = rows.filter((r) => r[c.name] == null || r[c.name] === "").length;
    return missingCount / rows.length > 0.2;
  });

  if (missingColumns.length > 0) {
    limitations.push(`Columns with >20% missing data: ${missingColumns.map((c) => c.name).join(", ")}`);
  }

  limitations.push("Correlation does not imply causation");
  limitations.push("Historical patterns may not predict future outcomes");

  return limitations;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function calculateDataQualityScore(columns: ColumnDef[], rows: Record<string, unknown>[]): number {
  if (rows.length === 0 || columns.length === 0) return 0;

  const totalCells = rows.length * columns.length;
  let missingCells = 0;

  for (const row of rows) {
    for (const col of columns) {
      if (row[col.name] == null || row[col.name] === "") {
        missingCells++;
      }
    }
  }

  return 1 - missingCells / totalCells;
}

function detectTimeRange(
  dateColumns: ColumnDef[],
  rows: Record<string, unknown>[],
): { start: string; end: string } | undefined {
  if (dateColumns.length === 0 || !dateColumns[0]) return undefined;

  const dateCol = dateColumns[0];
  const dates = rows
    .map((r) => {
      const raw = r[dateCol.name];
      if (raw == null || raw === "") return null;
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d;
    })
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  if (dates.length === 0) return undefined;

  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return undefined;

  return {
    start: first.toISOString().split("T")[0] ?? "",
    end: last.toISOString().split("T")[0] ?? "",
  };
}

/** Convert positional Cell[][] rows (or keyed objects) into keyed objects by column name. */
function toKeyedRows(rows: Cell[][] | Record<string, unknown>[], columns: ColumnDef[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      columns.forEach((c, i) => {
        obj[c.name] = row[i] ?? null;
      });
    } else {
      columns.forEach((c) => {
        obj[c.name] = row[c.name] ?? null;
      });
    }
    return obj;
  });
}
