/**
 * Copilot eval — grounded data answers (ROADMAP 6.2/6.3 for this surface).
 *
 * Golden tool-call fixtures: known dataset → known tool + args → known
 * engine output. The two grounded-answer tools must produce the SAME
 * numbers as the AI-visuals route (they call the same engines), and their
 * `facts` must be verbatim-citable by the grounding guard.
 */

import {
  execBuildDecompositionTree,
  execExplainKeyInfluencers,
  executeTool,
  TOOL_SPECS,
  type AgentContext,
} from "@/lib/copilot/tools";
import { buildDecompositionTree, findKeyInfluencers } from "@/lib/engine/ai-visuals";
import type { ColumnDef } from "@/lib/types";

// ---------------------------------------------------------------------------
// Golden dataset: 12 rows, churn outcome, region/product/rep dimensions.
// Hand-computed: churned = yes for 4 of 12 rows → base rate 1/3.
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
  { name: "region", type: "string" },
  { name: "product", type: "string" },
  { name: "rep", type: "string" },
  { name: "amount", type: "number" },
  { name: "churned", type: "string" },
];

const ROWS: (string | number | null)[][] = [
  ["East", "A", "Alice", 100, "yes"],
  ["East", "A", "Bob", 200, "yes"],
  ["East", "B", "Alice", 50, "no"],
  ["West", "A", "Alice", 150, "no"],
  ["West", "A", "Bob", 300, "no"],
  ["West", "B", "Bob", 120, "yes"],
  ["North", "A", "Alice", 80, "no"],
  ["North", "B", "Bob", 60, "yes"],
  ["North", "A", "Bob", 90, "no"],
  ["East", "B", "Bob", 70, "no"],
  ["West", "B", "Alice", 110, "no"],
  ["North", "A", "Alice", 140, "no"],
];

function ctx(): AgentContext {
  return {
    datasetId: "ds-1",
    datasetName: "golden.csv",
    columns: COLUMNS,
    rows: ROWS,
    totalRows: ROWS.length,
    datasetWarnings: [],
    metricValues: [],
  };
}

describe("copilot eval — tool registry integrity", () => {
  it("registers the two grounded-answer tools with required args", () => {
    const names = TOOL_SPECS.map((t) => t.name);
    expect(names).toContain("explain_key_influencers");
    expect(names).toContain("build_decomposition_tree");
    const influencers = TOOL_SPECS.find((t) => t.name === "explain_key_influencers")!;
    expect(influencers.required).toEqual(["outcomeColumn"]);
    const tree = TOOL_SPECS.find((t) => t.name === "build_decomposition_tree")!;
    expect(tree.required).toEqual(["measureColumn", "levels"]);
  });

  it("executeTool dispatches the new tools", () => {
    expect(executeTool("explain_key_influencers", { outcomeColumn: "churned" }, ctx()).tool).toBe(
      "explain_key_influencers",
    );
    expect(executeTool("build_decomposition_tree", { measureColumn: "amount", levels: ["region"] }, ctx()).tool).toBe(
      "build_decomposition_tree",
    );
  });
});

describe("copilot eval — explain_key_influencers golden answers", () => {
  it("computes the hand-known base rate and top influencer", () => {
    const res = execExplainKeyInfluencers(ctx(), { outcomeColumn: "churned" });
    expect(res.ok).toBe(true);
    // 4 of 12 rows churned → 33.3%
    expect(res.facts[0]).toContain("33.3%");
    // Default minCount=5: region/product groups are n=4 (skipped); rep groups are n=6.
    // rep=Bob: churned 3/6 = 50.0% (lift 1.50); rep=Alice: 1/6 = 16.7% (lift 0.50).
    const bobFact = res.facts.find((f) => f.includes('rep = "Bob"'));
    expect(bobFact).toBeTruthy();
    expect(bobFact).toContain("50.0%");
    expect(bobFact).toContain("lift 1.50");
    // Wilson interval present on every per-value fact — sample-size honesty.
    for (const f of res.facts.filter((x) => x.includes("rep ="))) {
      expect(f).toMatch(/Wilson 95% CI/);
    }
  });

  it("respects analyzeColumns and minCount filters", () => {
    const onlyProduct = execExplainKeyInfluencers(ctx(), {
      outcomeColumn: "churned",
      analyzeColumns: ["product"],
      minCount: 2,
    });
    for (const f of onlyProduct.facts) {
      expect(f.startsWith("product")).toBe(true);
    }
    // product=A: churned 2/7 = 28.6% (lift 0.86); product=B: 2/5 = 40.0% (lift 1.20).
    expect(onlyProduct.facts.some((f) => f.includes('product = "A"') && f.includes("lift 0.86"))).toBe(true);
    expect(onlyProduct.facts.some((f) => f.includes('product = "B"') && f.includes("lift 1.20"))).toBe(true);
  });

  it("rejects unknown outcome columns with the real column list", () => {
    const res = execExplainKeyInfluencers(ctx(), { outcomeColumn: "not_there" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not_there");
    expect(res.error).toContain("region, product, rep, amount, churned");
  });

  it("matches the AI-visuals route engine exactly (same numbers, two surfaces)", () => {
    const columns = COLUMNS.map((c) => c.name);
    const rows = ROWS.map((r) => r.map((v) => (v === null ? null : (v as string | number))));
    const direct = findKeyInfluencers({ columns, rows, outcomeColumn: "churned" });
    const viaTool = execExplainKeyInfluencers(ctx(), { outcomeColumn: "churned" });
    expect(viaTool.ok).toBe(true);
    const top = direct.influencers[0]!;
    const topFact = viaTool.facts.find((f) => f.includes(`${top.category} = "${top.value}"`));
    expect(topFact).toContain(`${(top.likelihood * 100).toFixed(1)}%`);
  });
});

describe("copilot eval — build_decomposition_tree golden answers", () => {
  it("decomposes amount by region with hand-known totals", () => {
    const res = execBuildDecompositionTree(ctx(), { measureColumn: "amount", levels: ["region"] });
    expect(res.ok).toBe(true);
    // Total = 100+200+50+150+300+120+80+60+90+70+110+140 = 1470
    expect(res.facts[0]).toContain("total amount: 1470");
    // East = 100+200+50+70 = 420; West = 150+300+120+110 = 680; North = 80+60+90+140 = 370
    const east = res.facts.find((f) => f.includes('region = "East"'));
    expect(east).toContain("420");
    const west = res.facts.find((f) => f.includes('region = "West"'));
    expect(west).toContain("680");
  });

  it("drills into the biggest branch for the second level", () => {
    const res = execBuildDecompositionTree(ctx(), { measureColumn: "amount", levels: ["region", "product"] });
    expect(res.ok).toBe(true);
    // West is the biggest branch (680): product A = 150+300 = 450, B = 120+110 = 230
    const within = res.facts.find((f) => f.includes('within region = "West"'));
    expect(within).toBeTruthy();
    expect(within).toContain("product");
  });

  it("applies deterministic filters before building", () => {
    const res = execBuildDecompositionTree(ctx(), {
      measureColumn: "amount",
      levels: ["region"],
      filters: [{ column: "product", value: "A" }],
    });
    expect(res.ok).toBe(true);
    // Only product A rows: East 300, West 450, North 310 → total 1060
    expect(res.facts[0]).toContain("1060");
  });

  it("rejects unknown columns and missing levels honestly", () => {
    expect(execBuildDecompositionTree(ctx(), { measureColumn: "nope", levels: ["region"] }).ok).toBe(false);
    expect(execBuildDecompositionTree(ctx(), { measureColumn: "amount", levels: ["nope"] }).ok).toBe(false);
    expect(execBuildDecompositionTree(ctx(), { measureColumn: "amount" }).ok).toBe(false);
    expect(execBuildDecompositionTree(ctx(), {}).ok).toBe(false);
  });

  it("matches the AI-visuals route engine exactly", () => {
    const columns = COLUMNS.map((c) => c.name);
    const rows = ROWS.map((r) => r.map((v) => (v === null ? null : (v as string | number))));
    const direct = buildDecompositionTree({ columns, rows, measureColumn: "amount", levels: ["region"] });
    const viaTool = execBuildDecompositionTree(ctx(), { measureColumn: "amount", levels: ["region"] });
    expect(viaTool.ok).toBe(true);
    expect(viaTool.facts[0]).toContain(`total amount: ${direct.value}`);
  });
});
