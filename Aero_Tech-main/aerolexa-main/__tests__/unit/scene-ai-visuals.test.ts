/**
 * AI-visual 3D layouts (S5) — oracle tests.
 *
 * The scene components render these layouts verbatim, so hand-computed
 * expectations here pin what users actually see: positions, heights and
 * colours are derived from the engine's computed numbers, never invented.
 */
import { buildDecompositionTree, findKeyInfluencers } from "@/lib/engine/ai-visuals";
import {
  buildInfluencersLayout,
  LOWERS_COLOR,
  MAX_BAR_HEIGHT,
  MIN_BAR_HEIGHT,
  RAISES_COLOR,
} from "@/lib/scene/ai-influencers";
import { buildTreeLayout, highlightedPathIds, nodeHeatColor, treeConnector, LEVEL_DROP } from "@/lib/scene/ai-tree";

// ---------------------------------------------------------------------------
// Fixture — mirrors __tests__/unit/ai-visuals.test.ts conventions
// ---------------------------------------------------------------------------

const columns = ["Region", "Segment", "Amount"];
const rows: (string | number | null)[][] = [
  ["East", "A", 100],
  ["East", "B", 60],
  ["West", "A", 40],
];

function treeFixture() {
  return buildDecompositionTree({ columns, rows, measureColumn: "Amount", levels: ["Region", "Segment"] });
}

function influencersFixture() {
  return findKeyInfluencers({
    columns: ["Region", "Churned"],
    rows: [
      ["East", true],
      ["East", true],
      ["East", true],
      ["East", false],
      ["East", false],
      ["West", false],
      ["West", false],
      ["West", false],
      ["West", false],
      ["West", false],
    ],
    outcomeColumn: "Churned",
    minCount: 3,
  });
}

// ---------------------------------------------------------------------------
// buildTreeLayout
// ---------------------------------------------------------------------------

describe("buildTreeLayout — decomposition tree physicalization", () => {
  it("lays the root at the origin with full parent share", () => {
    const layout = buildTreeLayout(treeFixture(), 3);
    const root = layout.nodes.find((n) => n.depth === 0);
    expect(root).toBeDefined();
    expect(root?.x).toBe(0);
    expect(root?.y).toBe(0);
    expect(root?.shareOfParent).toBeCloseTo(1);
    expect(layout.rootValue).toBe(200);
    expect(layout.nodeCount).toBe(layout.nodes.length);
  });

  it("drops each deeper level by LEVEL_DROP", () => {
    const layout = buildTreeLayout(treeFixture(), 3);
    const root = layout.nodes.find((n) => n.depth === 0)!;
    const children = layout.nodes.filter((n) => n.depth === 1);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.y).toBeCloseTo(root.y - LEVEL_DROP);
    }
  });

  it("spreads siblings symmetrically around the parent x", () => {
    const layout = buildTreeLayout(treeFixture(), 3);
    const children = layout.nodes.filter((n) => n.depth === 1).sort((a, b) => a.x - b.x);
    expect(children[0]!.x).toBeCloseTo(-children[1]!.x);
  });

  it("encodes height from share of parent within the slab band", () => {
    const layout = buildTreeLayout(treeFixture(), 3);
    for (const node of layout.nodes) {
      expect(node.height).toBeGreaterThanOrEqual(0.2);
      expect(node.height).toBeLessThanOrEqual(2.4);
      // share 1 → 0.2 + 2.2 = 2.4 (the root's exact height)
      if (node.shareOfParent === 1) expect(node.height).toBeCloseTo(2.4);
    }
  });

  it("respects maxDepth — grandchildren beyond it are not laid out", () => {
    const full = buildTreeLayout(treeFixture(), 3);
    const capped = buildTreeLayout(treeFixture(), 1);
    expect(capped.nodeCount).toBeLessThan(full.nodeCount);
    expect(capped.nodes.every((n) => n.depth <= 1)).toBe(true);
  });

  it("is deterministic — the same tree lays out identically twice", () => {
    expect(buildTreeLayout(treeFixture(), 3)).toEqual(buildTreeLayout(treeFixture(), 3));
  });
});

describe("treeConnector + highlightedPathIds + nodeHeatColor", () => {
  it("connector spans the vertical drop between parent and child", () => {
    const layout = buildTreeLayout(treeFixture(), 3);
    const root = layout.nodes.find((n) => n.depth === 0)!;
    const child = layout.nodes.find((n) => n.depth === 1)!;
    const c = treeConnector(root, child);
    expect(c.length).toBeCloseTo(LEVEL_DROP);
    expect(c.y).toBeCloseTo(-LEVEL_DROP / 2);
  });

  it("highlighted path returns the root-to-node chain for a real node", () => {
    const layout = buildTreeLayout(treeFixture(), 3);
    const deep = layout.nodes.find((n) => n.depth === 1)!;
    const path = highlightedPathIds(treeFixture(), deep.id);
    expect(path[0]).toBe("0:(all)");
    expect(path).toContain(deep.id);
  });

  it("highlighted path is empty for an unknown node (fail closed)", () => {
    expect(highlightedPathIds(treeFixture(), "9:ghost")).toEqual([]);
    expect(highlightedPathIds(treeFixture(), null)).toEqual([]);
  });

  it("nodeHeatColor endpoints match the accent→amber ramp", () => {
    expect(nodeHeatColor(0)).toBe("#3d9be9");
    expect(nodeHeatColor(1)).toBe("#ffb400");
    // Clamped, never out of range.
    expect(nodeHeatColor(-2)).toBe("#3d9be9");
    expect(nodeHeatColor(2)).toBe("#ffb400");
  });
});

// ---------------------------------------------------------------------------
// buildInfluencersLayout
// ---------------------------------------------------------------------------

describe("buildInfluencersLayout — key influencers physicalization", () => {
  it("heights decay from the strongest |lift − 1| and stay in the band", () => {
    const layout = buildInfluencersLayout(influencersFixture(), 8);
    expect(layout.bars.length).toBeGreaterThan(0);
    const heights = layout.bars.map((b) => b.height);
    // Sorted by |lift − 1| (the engine's order) → non-increasing heights.
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i - 1]!).toBeGreaterThanOrEqual(heights[i]!);
    }
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(MIN_BAR_HEIGHT);
      expect(h).toBeLessThanOrEqual(MAX_BAR_HEIGHT);
    }
  });

  it("the strongest bar reaches exactly MAX_BAR_HEIGHT", () => {
    const layout = buildInfluencersLayout(influencersFixture(), 8);
    expect(layout.bars[0]!.height).toBeCloseTo(MAX_BAR_HEIGHT);
  });

  it("direction colours: lift > 1 raises (teal), lift < 1 lowers (rose)", () => {
    const layout = buildInfluencersLayout(influencersFixture(), 8);
    for (const bar of layout.bars) {
      expect(bar.color).toBe(bar.raises ? RAISES_COLOR : LOWERS_COLOR);
      expect(bar.raises).toBe(bar.influencer.lift > 1);
    }
  });

  it("bars are centred on X and spaced by BAR_SPACING * index", () => {
    const layout = buildInfluencersLayout(influencersFixture(), 4);
    const xs = layout.bars.map((b) => b.x);
    if (xs.length >= 2) {
      expect(xs[1]! - xs[0]!).toBeCloseTo(1.2);
      const mid = (xs[0]! + xs[xs.length - 1]!) / 2;
      expect(mid).toBeCloseTo(0);
    }
  });

  it("carries the engine's base rate and total rows verbatim", () => {
    const engine = influencersFixture();
    const layout = buildInfluencersLayout(engine, 8);
    expect(layout.baseRate).toBe(engine.baseRate);
    expect(layout.totalRows).toBe(engine.totalRows);
  });

  it("caps bars at maxBars and is deterministic", () => {
    const engine = influencersFixture();
    expect(buildInfluencersLayout(engine, 1).bars).toHaveLength(1);
    expect(buildInfluencersLayout(engine, 8)).toEqual(buildInfluencersLayout(engine, 8));
  });
});
