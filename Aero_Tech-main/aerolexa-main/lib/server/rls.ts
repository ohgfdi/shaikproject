/**
 * RLS (row-level security) rule server layer.
 *
 * Power BI–style RLS: an admin declares rules like
 *   role "VIEWER" → Dataset X, column "Region" ∈ {"East"}
 * and every visual evaluation resolves the current user's rules BEFORE the
 * measure runs, so a viewer scoped to "East" sees only East rows in every
 * visual, dashboard tile and pivot — regardless of what filters they pass.
 *
 * Storage: Workspace.settings JSON (`rlsRules` key) — no migration needed;
 * the field is read/written defensively so workspaces without it behave as
 * "no rules" (full access).
 *
 * Enforcement: `filtersForUser` resolves the rule set for ONE user (their
 * project roles + workspace role); callers pass the result into the engines
 * (semantic model rowFilters, DAX filter context, pivot previews) so the
 * restriction is applied server-side before any number is computed. Rules
 * NEVER widen access — an absent rule set means unrestricted.
 */

import { prisma } from "@/lib/db";
import type { RlsRule } from "@/lib/engine/semantic-model";

export interface StoredRlsRule {
  id: string;
  /** Workspace role this rule binds to: OWNER | EDITOR | VIEWER. */
  role: string;
  /** Dataset (table) the rule filters. */
  datasetId: string;
  datasetName: string;
  column: string;
  /** Allowed values (AND-ed across rules for the same user). */
  values: (string | number | boolean)[];
  createdAt?: string;
}

const SETTINGS_KEY = "rlsRules";

/** Load all stored RLS rules for a workspace ([] when none). */
export async function loadRlsRules(workspaceId: string): Promise<StoredRlsRule[]> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { settings: true },
  });
  if (!ws?.settings) return [];
  try {
    const parsed = JSON.parse(ws.settings) as Record<string, unknown>;
    const rules = parsed[SETTINGS_KEY];
    return Array.isArray(rules) ? (rules as StoredRlsRule[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full rule list for a workspace (defensive merge with other settings). */
export async function saveRlsRules(workspaceId: string, rules: StoredRlsRule[]): Promise<void> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  let settings: Record<string, unknown> = {};
  if (ws?.settings) {
    try {
      settings = JSON.parse(ws.settings) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  settings[SETTINGS_KEY] = rules;
  await prisma.workspace.update({ where: { id: workspaceId }, data: { settings: JSON.stringify(settings) } });
}

export interface RlsContext {
  /** The current user's id (rule matching is per-user via role). */
  userId: string;
  /** The user's role on THIS project (or workspace fallback) — OWNER/EDITOR/VIEWER. */
  role: string;
}

/**
 * Resolve the row filters that apply to a user for one dataset.
 * Returns [] when the user is unrestricted (e.g. OWNER, or no rule exists).
 */
export function filtersForUser(
  rules: StoredRlsRule[],
  role: string,
  datasetId: string,
): { column: string; values: (string | number | boolean)[] }[] {
  return rules
    .filter((r) => r.role === role && r.datasetId === datasetId)
    .map((r) => ({ column: r.column, values: r.values }));
}

/**
 * Resolve filters for a user across every dataset, keyed by datasetId —
 * the shape visual endpoints consume.
 */
export function filtersForUserByDataset(
  rules: StoredRlsRule[],
  role: string,
): Map<string, { column: string; values: (string | number | boolean)[] }[]> {
  const byDataset = new Map<string, { column: string; values: (string | number | boolean)[] }[]>();
  for (const r of rules) {
    if (r.role !== role) continue;
    const list = byDataset.get(r.datasetId) ?? [];
    list.push({ column: r.column, values: r.values });
    byDataset.set(r.datasetId, list);
  }
  return byDataset;
}

/** Convert stored rules to the engine's RlsRule shape for resolveRowFilters. */
export function toEngineRules(rules: StoredRlsRule[]): RlsRule[] {
  return rules.map((r) => ({ role: r.role, table: r.datasetId, column: r.column, values: r.values }));
}

/**
 * Audit helper: a compact description of the active restrictions for a user —
 * surfaced in the UI ("You are seeing a restricted view") so restricted users
 * KNOW their view is filtered (never silently).
 */
export function describeRestrictions(rules: StoredRlsRule[], role: string): string[] {
  return rules
    .filter((r) => r.role === role)
    .map((r) => `${r.datasetName}[${r.column}] ∈ { ${r.values.map(String).join(", ")} }`);
}

// ---------------------------------------------------------------------------
// Row enforcement (pure — unit-gated)
// ---------------------------------------------------------------------------

export interface RlsRowFilterResult {
  rows: (string | number | boolean | null)[][];
  /** Human-readable note appended to engine notes; "" when unrestricted. */
  note: string;
  applied: boolean;
}

/**
 * Apply RLS row filters to typed dataset rows. Filters AND together (a row
 * must satisfy every rule). Values compare with String() coercion so numeric
 * columns match numeric rule values regardless of storage typing.
 */
export function applyRlsToRows(
  rows: (string | number | boolean | null)[][],
  columns: { name: string }[],
  filters: { column: string; values: (string | number | boolean)[] }[],
): RlsRowFilterResult {
  if (!filters.length) return { rows, note: "", applied: false };
  const idxByCol = new Map(columns.map((c, i) => [c.name, i] as const));
  const checks: { idx: number; allowed: Set<string> }[] = [];
  for (const f of filters) {
    const idx = idxByCol.get(f.column);
    if (idx === undefined) {
      // Rule references a column the dataset no longer has: fail CLOSED —
      // a broken rule must never widen visibility.
      return {
        rows: [],
        note: ` Row-level security: rule column “${f.column}” no longer exists on this dataset, so 0 rows are visible.`,
        applied: true,
      };
    }
    checks.push({ idx, allowed: new Set(f.values.map((v) => String(v))) });
  }
  const out = rows.filter((row) => checks.every((c) => c.allowed.has(String(row[c.idx] ?? ""))));
  const desc = filters.map((f) => `${f.column} ∈ { ${f.values.map(String).join(", ")} }`).join(" AND ");
  const note =
    out.length === rows.length
      ? ` Row-level security active (${desc}); all ${rows.length} rows match.`
      : ` Row-level security active (${desc}): showing ${out.length.toLocaleString()} of ${rows.length.toLocaleString()} rows.`;
  return { rows: out, note, applied: true };
}
