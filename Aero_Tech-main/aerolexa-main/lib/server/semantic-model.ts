/**
 * Semantic-model server layer — the bridge between the app's datasets
 * (ProjectJoinMapping + CustomMetric rows) and the pure semantic engine
 * (`lib/engine/semantic-model.ts`).
 *
 * A project's "model" is:
 *  - tables:        the project's datasets
 *  - relationships: ProjectJoinMapping rows (left/right columns interpreted
 *                   as many→one keys; validated with the engine's
 *                   star-schema checks: duplicate keys on the one side,
 *                   orphan rows on the many side)
 *  - measures:      CustomMetric rows scoped to a dataset in the project
 *
 * `evaluateProjectMeasure` compiles the model in memory and evaluates a
 * measure with optional RELATED() dimension filters and RLS-style row
 * filters — the same math the engine's oracle tests pin, computed from the
 * real rows. Nothing here is cached or simulated; each call reads the
 * current stored rows.
 */

// TENANCY_GLOBAL_MARKER: tenancy-audit: global-operator - semantic model is a deployment-wide aggregate operation
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { DaxError, type DaxFilter } from "@/lib/engine/dax";
import { evaluateMultiMeasure, type MultiDimensionInput } from "@/lib/engine/dax-multi";
import {
  buildSemanticModel,
  type Relationship,
  type SemanticIssue,
  type SemanticTable,
} from "@/lib/engine/semantic-model";
import { serverEnv } from "@/lib/env";
import type { AccessPrincipal } from "@/lib/server/dataset-access";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import type { ColumnDef, SqlValue } from "@/lib/types";

export interface ProjectModelTables {
  name: string;
  datasetId: string;
  rowCount: number;
  columns: { name: string; type: string }[];
}

export interface ProjectModelRelationship {
  id: string;
  name: string;
  manyTable: string;
  manyColumn: string;
  oneTable: string;
  oneColumn: string;
  warnings: string[];
}

export interface ProjectModelMeasure {
  id: string;
  name: string;
  description: string | null;
  daxExpression: string;
  format: string;
  datasetId: string | null;
  datasetName: string | null;
  isGlobal: boolean;
}

export interface ProjectModelSummary {
  tables: ProjectModelTables[];
  relationships: ProjectModelRelationship[];
  measures: ProjectModelMeasure[];
  /** Star-schema issues found when the relationships were last validated. */
  issues: SemanticIssue[];
}

/** Load (and validate) the project's semantic model from stored rows. */
export async function loadProjectModel(workspaceId: string, projectId: string): Promise<ProjectModelSummary> {
  const [datasets, mappings] = await Promise.all([
    prisma.dataset.findMany({
      where: { projectId, workspaceId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, rowCount: true, columns: true },
    }),
    prisma.projectJoinMapping.findMany({
      where: { projectId, workspaceId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const tables: ProjectModelTables[] = datasets.map((d) => ({
    name: d.name,
    datasetId: d.id,
    rowCount: d.rowCount,
    columns: d.columns ? (JSON.parse(d.columns as string) as { name: string; type: string }[]) : [],
  }));

  const relationships: ProjectModelRelationship[] = mappings.map((m) => ({
    id: m.id,
    name: `${m.leftDatasetId === m.rightDatasetId ? m.leftColumn : `${tableName(datasets, m.leftDatasetId)}[${m.leftColumn}] → ${tableName(datasets, m.rightDatasetId)}[${m.rightColumn}]`}`,
    manyTable: tableName(datasets, m.leftDatasetId),
    manyColumn: m.leftColumn,
    oneTable: tableName(datasets, m.rightDatasetId),
    oneColumn: m.rightColumn,
    warnings: parseWarnings(m.warnings),
  }));

  const measures = await prisma.customMetric.findMany({
    where: { workspaceId, projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return {
    tables,
    relationships,
    measures: measures.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      daxExpression: m.daxExpression,
      format: m.format,
      datasetId: m.datasetId,
      datasetName: datasets.find((d) => d.id === m.datasetId)?.name ?? null,
      isGlobal: m.isGlobal,
    })),
    issues: await validateRelationships(workspaceId, projectId, mappings),
  };
}

function tableName(datasets: { id: string; name: string }[], id: string): string {
  return datasets.find((d) => d.id === id)?.name ?? "(deleted)";
}

function parseWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Re-validate every stored relationship against the actual rows with the
 * engine's star-schema checks. Returns engine issues plus the mapped rows so
 * the UI can show exactly which key is broken.
 */
export async function validateRelationships(
  workspaceId: string,
  projectId: string,
  mappings: {
    id: string;
    leftDatasetId: string;
    leftColumn: string;
    rightDatasetId: string;
    rightColumn: string;
    warnings: string;
  }[],
): Promise<SemanticIssue[]> {
  if (mappings.length === 0) return [];
  const datasets = await prisma.dataset.findMany({
    where: { projectId, workspaceId, id: { in: mappings.flatMap((m) => [m.leftDatasetId, m.rightDatasetId]) } },
    select: { id: true, name: true, rowCount: true },
  });
  if (datasets.length === 0) return [];

  // Build the tables needed by the referenced datasets (columns + rows).
  const tablesById = new Map<string, SemanticTable>();
  for (const d of datasets) {
    const full = await prisma.dataset.findUnique({ where: { id: d.id }, select: { columns: true } });
    const columns = full?.columns ? (JSON.parse(full.columns) as { name: string; type: string }[]) : [];
    const loaded = await loadParsedDataset(d.id, serverEnv().DATASET_ANALYSIS_LIMIT);
    tablesById.set(d.id, {
      name: d.name,
      role: "fact",
      model: { columns: columns.map((c) => c.name), rows: loaded.rows as SqlValue[][] },
    });
  }

  const allIssues: SemanticIssue[] = [];
  for (const m of mappings) {
    const many = tablesById.get(m.leftDatasetId);
    const one = tablesById.get(m.rightDatasetId);
    if (!many || !one) {
      allIssues.push({
        severity: "error",
        relationship: m.id,
        message: "A dataset in this relationship no longer exists.",
      });
      continue;
    }
    const rel: Relationship = {
      name: m.id,
      fromTable: many.name,
      fromColumn: m.leftColumn,
      toTable: one.name,
      toColumn: m.rightColumn,
      cardinality: "many-to-one",
    };
    const { issues } = buildSemanticModel([many, one], [rel]);
    allIssues.push(...issues);
  }
  return allIssues;
}

export interface EvaluateMeasureInput {
  workspaceId: string;
  projectId: string;
  /** Measure expression, e.g. "SUM([Amount])" or "CALCULATE(SUM([Amount]), RELATED('DimCustomer'[Segment]) = \"VIP\")" — full single-table + joined multi-table DAX. */
  daxExpression: string;
  /** Optional dimension filter: RELATED(oneTable[oneColumn]) ∈ values. */
  relatedFilter?: {
    relationshipId: string;
    values: (string | number | boolean)[];
  };
  /** Optional RLS row filter on the fact table. */
  rowFilter?: {
    column: string;
    values: (string | number | boolean)[];
  };
  /**
   * The caller. When present, the caller's role and the dataset owner's RLS
   * rules are resolved here, so a client-supplied `rowFilter` can only NARROW
   * the view — never widen past the caller's restrictions.
   */
  principal?: AccessPrincipal;
}

export interface EvaluateMeasureResult {
  value: number | null;
  /** The tables, relationships and filters actually applied (transparency panel). */
  applied: string[];
  /** Rows used after filters. */
  rowsUsed: number;
}

/**
 * Parse a simple `<AGG>([column])` measure expression (a wrapping
 * CALCULATE(...) is tolerated). Kept for callers that only need the
 * single-aggregation form.
 */
export function parseSimpleAggregation(expr: string): { aggregation: string; column: string } | null {
  const trimmed = expr.trim();
  // A wrapping CALCULATE(...) is tolerated: take the inner expression only
  // when the whole string is CALCULATE-wrapped (never strip a bare trailing
  // paren — that broke plain "SUM([Amount])" expressions).
  const inner = /^CALCULATE\s*\((.*)\)$/is.exec(trimmed)?.[1] ?? trimmed;
  const match = /^(sum|average|avg|min|max|count|distinctcount|distinctcountrows)\s*\(\s*\[([^\]]+)\]\s*\)$/i.exec(
    inner.trim(),
  );
  if (!match) return null;
  const agg = match[1]!.toLowerCase();
  return {
    aggregation: agg === "avg" ? "average" : agg === "distinctcountrows" ? "distinctcount" : agg,
    column: match[2]!,
  };
}

/** The dataset's columns as loaded from storage (defensive parse). */
async function loadedTable(
  datasetId: string,
  principal?: AccessPrincipal,
): Promise<{ name: string; columns: string[]; rows: SqlValue[][]; rlsNote: string }> {
  const ds = await prisma.dataset.findUnique({ where: { id: datasetId } });
  const cols = ds?.columns ? (JSON.parse(ds.columns) as ColumnDef[]) : ([] as ColumnDef[]);
  const loaded = await loadParsedDataset(datasetId, serverEnv().DATASET_ANALYSIS_LIMIT);
  let rows = loaded.rows;
  let rlsNote = "";
  if (principal && ds) {
    // RLS: the semantic model's fact and dimension tables are dataset reads
    // like any other, so the caller's restrictions apply before a measure runs.
    const security = await applyRowSecurity(principal, ds, { rows: loaded.rows, columns: cols });
    rows = security.rows;
    rlsNote = security.note;
  }
  return {
    name: ds?.name ?? "(deleted)",
    columns: cols.map((c) => c.name),
    rows: rows as SqlValue[][],
    rlsNote,
  };
}

/**
 * Evaluate a DAX measure over the project's semantic model (ROADMAP 2.2).
 * The fact table is the "many" side of the selected relationship (or the
 * project's only dataset); every stored relationship ONTO that fact is
 * materialized as a dimension, so full DAX — table-qualified references and
 * RELATED() — evaluates across the join graph, plus the auto date dimension
 * (ROADMAP 2.4). Optional RELATED() dimension filters and RLS row filters are
 * applied as DAX filters BEFORE the measure runs.
 */
export async function evaluateProjectMeasure(input: EvaluateMeasureInput): Promise<EvaluateMeasureResult> {
  const mapping = input.relatedFilter
    ? await prisma.projectJoinMapping.findFirst({
        where: { id: input.relatedFilter.relationshipId, projectId: input.projectId, workspaceId: input.workspaceId },
      })
    : null;

  const applied: string[] = [];
  if (input.relatedFilter && !mapping) {
    throw new Error("The selected relationship no longer exists. Refresh the model and retry.");
  }

  // The fact table is the "many" side of the selected relationship (or the
  // only table in the project).
  let factDatasetId: string;
  if (mapping) {
    factDatasetId = mapping.leftDatasetId;
  } else {
    const only = await prisma.dataset.findFirst({
      where: { projectId: input.projectId, workspaceId: input.workspaceId },
    });
    if (!only) throw new Error("This project has no datasets yet — upload one first.");
    factDatasetId = only.id;
  }

  const fact = await loadedTable(factDatasetId, input.principal);
  applied.push(`Fact: ${fact.name} · ${fact.rows.length} row(s)`);
  if (fact.rlsNote) applied.push(`Row-level security: ${fact.rlsNote.trim()}`);

  // Every stored relationship onto the fact becomes a dimension. Group by the
  // one-side dataset: one table, one join (the first mapping wins per table).
  const mappings = await prisma.projectJoinMapping.findMany({
    where: { projectId: input.projectId, workspaceId: input.workspaceId },
    orderBy: { createdAt: "asc" },
  });
  const dimensions: MultiDimensionInput[] = [];
  const seenOneSide = new Map<string, { rightColumn: string; rightName: string }>();
  for (const m of mappings) {
    if (m.leftDatasetId !== factDatasetId) continue;
    if (seenOneSide.has(m.rightDatasetId)) continue;
    seenOneSide.set(m.rightDatasetId, { rightColumn: m.rightColumn, rightName: "" });
  }
  for (const [oneId, ref] of seenOneSide) {
    try {
      const one = await loadedTable(oneId);
      ref.rightName = one.name;
      dimensions.push({
        name: one.name,
        fromColumn: mappings.find((m) => m.rightDatasetId === oneId)!.leftColumn,
        toColumn: ref.rightColumn,
        model: { columns: one.columns, rows: one.rows },
      });
      applied.push(`Dimension: ${one.name} (${one.columns.length} column(s))`);
    } catch (err) {
      applied.push(`Dimension: (skipped, ${err instanceof Error ? err.message : "unavailable"})`);
    }
  }

  // RLS / row filter first — the security filter precedes everything.
  const filters: DaxFilter[] = [];
  if (input.rowFilter) {
    filters.push({ column: input.rowFilter.column, values: input.rowFilter.values.map(String) });
    applied.push(`Row filter ${input.rowFilter.column} ∈ [${input.rowFilter.values.join(", ")}]`);
  }
  // Related-dimension filter: qualified as <oneTable>.<column> on the model.
  if (input.relatedFilter && mapping) {
    const ref = seenOneSide.get(mapping.rightDatasetId);
    const dimCol = `${ref?.rightName ?? "(deleted)"}.${mapping.rightColumn}`;
    filters.push({ column: dimCol, values: input.relatedFilter.values.map(String) });
    applied.push(`RELATED(${mapping.rightColumn}) filter`);
  }

  let value: number | null = null;
  try {
    const result = evaluateMultiMeasure(
      {
        fact: { columns: fact.columns, rows: fact.rows },
        dimensions,
        autoDateDimension: true,
      },
      input.daxExpression,
      filters,
    );
    value = typeof result === "number" ? result : result === true ? 1 : result === false ? 0 : value;
  } catch (err) {
    if (err instanceof DaxError) {
      throw new Error(err.message);
    }
    throw err;
  }

  return { value, applied, rowsUsed: fact.rows.length };
}
