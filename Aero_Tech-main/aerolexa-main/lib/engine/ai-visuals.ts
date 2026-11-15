/**
 * Power BI "AI visual" engines — deterministic statistics, no LLM.
 *
 * DecompositionTree: builds the full tree of a measure sliced by successive
 *   levels, ranking each node's children by contribution-to-total difference
 *   from the parent distribution (chi-square-style contrast, same intuition as
 *   Power BI's tree: "which slice explains the most variance").
 *
 * KeyInfluencers: univariate analysis of which categorical value shifts the
 *   likelihood of a boolean outcome, with Wilson score intervals and lift
 *   versus the base rate — the same headline numbers Power BI shows.
 */
import type { SqlValue } from "@/lib/types";

// ---------------------------------------------------------------------------
// Decomposition tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  /** Slice value of this node under its level column ("(all)" for root). */
  label: string;
  levelColumn: string | null;
  value: number;
  /** Share of parent's value; root = 1. */
  shareOfParent: number;
  shareOfTotal: number;
  children: TreeNode[];
  /** Children ranked by |share − expected|; set on nodes before expansion. */
  depth: number;
}

export interface TreeRequest {
  columns: string[];
  rows: SqlValue[][];
  measureColumn: string;
  /** Slice levels in drill order. */
  levels: string[];
  /** Optional deterministic filter applied before building the tree. */
  filters?: { column: string; value: string }[];
}

function measureOf(row: SqlValue[], idx: number): number {
  const v = row[idx];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function buildDecompositionTree(req: TreeRequest): TreeNode {
  const colIdx = new Map(req.columns.map((c, i) => [c, i] as const));
  const mIdx = colIdx.get(req.measureColumn);
  if (mIdx === undefined) throw new Error(`Measure column “${req.measureColumn}” not found.`);
  for (const lv of req.levels) {
    if (!colIdx.has(lv)) throw new Error(`Level column “${lv}” not found.`);
  }

  let rows = req.rows;
  if (req.filters?.length) {
    rows = rows.filter((r) => req.filters!.every((f) => String(r[colIdx.get(f.column)!]) === f.value));
  }

  const total = rows.reduce((s, r) => s + measureOf(r, mIdx), 0);

  const buildNode = (
    subset: SqlValue[][],
    label: string,
    levelColumn: string | null,
    depth: number,
    parentValue: number,
  ): TreeNode => {
    const value = subset.reduce((s, r) => s + measureOf(r, mIdx), 0);
    const node: TreeNode = {
      label,
      levelColumn,
      value,
      shareOfParent: parentValue === 0 ? 0 : value / parentValue,
      shareOfTotal: total === 0 ? 0 : value / total,
      children: [],
      depth,
    };
    if (depth >= req.levels.length) return node;

    const levelCol = req.levels[depth]!;
    const idx = colIdx.get(levelCol)!;
    const groups = new Map<string, SqlValue[][]>();
    for (const r of subset) {
      const key = String(r[idx] ?? "");
      let g = groups.get(key);
      if (!g) {
        g = [];
        groups.set(key, g);
      }
      g.push(r);
    }
    // Rank children by |share − expected uniform share| — the biggest
    // contributors/misfits first, mirroring the Power BI tree's default order.
    const childNodes = [...groups.entries()]
      .map(([key, g]) => {
        const child = buildNode(g, key, levelCol, depth + 1, value);
        return child;
      })
      .sort((a, b) => {
        const expected = 1 / groups.size;
        const da = Math.abs(a.shareOfParent - expected);
        const db = Math.abs(b.shareOfParent - expected);
        if (db !== da) return db - da;
        return b.value - a.value;
      });
    node.children = childNodes;
    return node;
  };

  return buildNode(rows, "(all)", null, 0, total || 1);
}

// ---------------------------------------------------------------------------
// Key influencers
// ---------------------------------------------------------------------------

export interface Influencer {
  category: string;
  value: string;
  /** P(outcome | value) estimated from the data. */
  likelihood: 0 | 0.5 | 1 | number;
  count: number;
  /** Wilson 95% lower/upper bounds — shown so users see sample-size honesty. */
  ciLow: number;
  ciHigh: number;
  /** likelihood / base rate. >1 raises likelihood, <1 lowers it. */
  lift: number;
  /** Row count behind the estimate; small counts are labelled low-confidence. */
  strength: "strong" | "moderate" | "weak";
}

export interface KeyInfluencersResult {
  baseRate: number;
  totalRows: number;
  /** Top influencers across all analysed columns, sorted by |lift − 1|. */
  influencers: Influencer[];
  /** Columns skipped for lack of categorical signal. */
  skippedColumns: string[];
}

export interface KeyInfluencersRequest {
  columns: string[];
  rows: SqlValue[][];
  /** Boolean outcome column (true/"1"/"yes" = positive class). */
  outcomeColumn: string;
  /** Columns to analyse as potential influencers. Defaults to all others. */
  analyzeColumns?: string[];
  /** Minimum rows behind an estimate to include it. */
  minCount?: number;
}

const POSITIVE = new Set(["true", "1", "yes", "y"]);

function isPositiveOutcome(v: SqlValue): boolean {
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return POSITIVE.has(v.trim().toLowerCase());
  return false;
}

/** Wilson score interval (95%) for a binomial proportion. */
function wilson(successes: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054; // 95%
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { low: Math.max(0, (center - spread) / denom), high: Math.min(1, (center + spread) / denom) };
}

export function findKeyInfluencers(req: KeyInfluencersRequest): KeyInfluencersResult {
  const colIdx = new Map(req.columns.map((c, i) => [c, i] as const));
  const oIdx = colIdx.get(req.outcomeColumn);
  if (oIdx === undefined) throw new Error(`Outcome column “${req.outcomeColumn}” not found.`);

  const outcomes = req.rows.map((r) => isPositiveOutcome(r[oIdx] ?? null));
  const totalRows = req.rows.length;
  const positives = outcomes.filter(Boolean).length;
  const baseRate = totalRows ? positives / totalRows : 0;

  const analyze = req.analyzeColumns?.length ? req.analyzeColumns : req.columns.filter((c) => c !== req.outcomeColumn);
  const skipped: string[] = [];
  const influencers: Influencer[] = [];
  const minCount = req.minCount ?? 5;

  for (const col of analyze) {
    const idx = colIdx.get(col);
    if (idx === undefined) {
      skipped.push(col);
      continue;
    }
    // Skip near-unique columns: they can't generalize (like IDs).
    const distinct = new Set(req.rows.map((r) => String(r[idx] ?? "")));
    if (distinct.size >= Math.min(30, Math.max(6, totalRows * 0.5))) {
      skipped.push(col);
      continue;
    }

    const groups = new Map<string, { n: number; pos: number }>();
    for (let i = 0; i < req.rows.length; i++) {
      const key = String(req.rows[i]![idx] ?? "");
      let g = groups.get(key);
      if (!g) {
        g = { n: 0, pos: 0 };
        groups.set(key, g);
      }
      g.n++;
      if (outcomes[i]) g.pos++;
    }
    for (const [value, g] of groups) {
      if (g.n < minCount) continue;
      const likelihood = g.pos / g.n;
      const ci = wilson(g.pos, g.n);
      const lift = baseRate === 0 ? 0 : likelihood / baseRate;
      influencers.push({
        category: col,
        value,
        likelihood,
        count: g.n,
        ciLow: ci.low,
        ciHigh: ci.high,
        lift,
        strength: g.n >= 30 && Math.min(ci.low, 1 - ci.high) >= 0.05 ? "strong" : g.n >= 10 ? "moderate" : "weak",
      });
    }
  }

  influencers.sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1));

  return { baseRate, totalRows, influencers: influencers.slice(0, 50), skippedColumns: skipped };
}
