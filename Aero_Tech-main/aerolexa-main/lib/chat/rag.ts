/**
 * Chat RAG — retrieval-augmented grounding over the WORKSPACE's own facts.
 *
 * The copilot already had web search (external RAG); this module adds the
 * internal half: a deterministic, dependency-free retriever over a small
 * index of real workspace facts (datasets, projects, artifacts) that the
 * chat route builds from Prisma. Grounding is keyword-scored — TF-like
 * overlap with a small idf-ish boost for rarer tokens — no embeddings, no
 * external API, so retrieval is reproducible and testable in CI.
 *
 * Honesty contract (matches renderPersonalContext in lib/chat/engine.ts):
 * - Only names, counts, kinds and timestamps enter the index. Never row
 *   values — the chat route cannot read dataset rows, and must not pretend.
 * - The rendered context explicitly tells the model what it may claim.
 */

// ---------------------------------------------------------------------------
// Index types
// ---------------------------------------------------------------------------

export type RagKind =
  "dataset" | "project" | "dashboard" | "report" | "presentation" | "analysis" | "notebook" | "model";

export interface RagFact {
  id: string;
  kind: RagKind;
  title: string;
  /** One factual line, e.g. "sales.csv — 12,345 rows × 8 columns". */
  sub?: string;
  /** Extra indexable keywords (e.g. dataset column names). */
  keywords?: string[];
}

/** One retrieved fact with its score (for debugging + tests). */
export interface RagHit {
  fact: RagFact;
  score: number;
  /**
   * Which retrieval channels surfaced this hit (e.g. ["bm25","vector"] for the
   * deterministic hybrid, ["bm25","embedding"] when a configured embedding
   * provider ran). Optional — the pure-lexical retriever leaves it unset.
   */
  channels?: string[];
}

/** Tokenize for retrieval: lowercase, split on non-alphanumerics, drop 1-char tokens. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_][a-z0-9_-]*/g) ?? []).filter((t) => t.length > 1);
}

/** Document text a fact is matched against. */
function factText(fact: RagFact): string {
  return [fact.title, fact.sub ?? "", ...(fact.keywords ?? [])].join(" ");
}

/** Rare tokens get more weight — a tiny idf over the index itself. */
function idf(index: RagFact[], token: string): number {
  const docFreq = index.filter((f) => tokenize(factText(f)).includes(token)).length;
  if (docFreq === 0) return 1.6; // unseen in the index but present in a fact's raw text (title-only match)
  return 1 + 0.6 * (1 - docFreq / index.length);
}

/**
 * Retrieve the facts most relevant to the user's message.
 * Returns up to `limit` hits scored > 0, best first. Deterministic: equal
 * scores break by kind then title so tests and UI stay stable.
 */
export function retrieveFacts(message: string, index: RagFact[], limit = 5): RagHit[] {
  const queryTokens = new Set(tokenize(message));
  if (queryTokens.size === 0 || index.length === 0) return [];
  const hits: RagHit[] = [];
  for (const fact of index) {
    const docTokens = tokenize(factText(fact));
    if (docTokens.length === 0) continue;
    let score = 0;
    const seen = new Set<string>();
    for (const token of docTokens) {
      if (!queryTokens.has(token) || seen.has(token)) continue;
      seen.add(token);
      // Title hits outrank metadata hits — a dataset named "churn" matters
      // more than one that merely mentions churn in a column list.
      score += (fact.title.toLowerCase().includes(token) ? 2 : 1) * idf(index, token);
    }
    if (score > 0) hits.push({ fact, score: Math.round(score * 100) / 100 });
  }
  return hits
    .sort(
      (a, b) => b.score - a.score || a.fact.kind.localeCompare(b.fact.kind) || a.fact.title.localeCompare(b.fact.title),
    )
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rendering — what the model actually sees
// ---------------------------------------------------------------------------

/**
 * Render retrieved facts as the grounding block appended to the system
 * prompt. Empty index / no hits → "" (the persona stays honest about
 * workspace facts through renderPersonalContext alone).
 */
export function renderRagContext(hits: RagHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => ` - [${h.fact.kind}] ${h.fact.title}${h.fact.sub ? ` — ${h.fact.sub}` : ""}`);
  return [
    "Relevant items from the user's workspace (real metadata — use to personalise answers and point the user to the right surface):",
    ...lines,
    "You know these items EXIST and their metadata above. You have NOT read their row data; never quote values, summaries or statistics from them. Suggest opening the item in the workspace for the actual numbers.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Index building (pure reshaping of route-loaded rows)
// ---------------------------------------------------------------------------

export interface DatasetIndexRow {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  columnNames?: string[];
}

export interface ProjectIndexRow {
  id: string;
  name: string;
  description?: string | null;
  company?: string | null;
}

export interface ArtifactIndexRow {
  id: string;
  title: string;
  kind?: string | null;
}

/** Build the retrieval index from the rows the chat route loads. */
export function buildWorkspaceIndex(input: {
  datasets?: DatasetIndexRow[];
  projects?: ProjectIndexRow[];
  dashboards?: ArtifactIndexRow[];
  reports?: ArtifactIndexRow[];
  presentations?: ArtifactIndexRow[];
  analyses?: ArtifactIndexRow[];
  notebooks?: ArtifactIndexRow[];
  models?: ArtifactIndexRow[];
}): RagFact[] {
  const facts: RagFact[] = [];
  for (const d of input.datasets ?? []) {
    facts.push({
      id: d.id,
      kind: "dataset",
      title: d.name,
      sub: `${d.rowCount.toLocaleString()} rows × ${d.columnCount} columns`,
      keywords: (d.columnNames ?? []).slice(0, 40),
    });
  }
  for (const p of input.projects ?? []) {
    facts.push({ id: p.id, kind: "project", title: p.name, sub: p.company ?? p.description ?? undefined });
  }
  const artifact = (rows: ArtifactIndexRow[] | undefined, kind: RagKind) => {
    for (const a of rows ?? []) facts.push({ id: a.id, kind, title: a.title, sub: a.kind ?? undefined });
  };
  artifact(input.dashboards, "dashboard");
  artifact(input.reports, "report");
  artifact(input.presentations, "presentation");
  artifact(input.analyses, "analysis");
  artifact(input.notebooks, "notebook");
  artifact(input.models, "model");
  return facts;
}
