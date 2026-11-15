/**
 * Chat RAG — retrieval over the workspace-fact index.
 * Deterministic keyword scoring: pinned known-answer + honesty contracts.
 */

import { buildWorkspaceIndex, renderRagContext, retrieveFacts, tokenize, type RagFact } from "@/lib/chat/rag";

const INDEX: RagFact[] = buildWorkspaceIndex({
  datasets: [
    {
      id: "d1",
      name: "sales-invoices.csv",
      rowCount: 1234,
      columnCount: 8,
      columnNames: ["InvoiceDate", "Amount", "Gstin"],
    },
    { id: "d2", name: "payroll.xlsx", rowCount: 300, columnCount: 5, columnNames: ["Employee", "NetPay"] },
  ],
  projects: [{ id: "p1", name: "GST recon 2026", description: "Monthly GST reconciliation" }],
  dashboards: [{ id: "b1", title: "Revenue overview" }],
  reports: [{ id: "r1", title: "Audit working papers" }],
});

describe("chat rag — tokenize", () => {
  it("lowercases, splits, and drops 1-char tokens", () => {
    expect(tokenize("Which Dataset has Invoice Dates?")).toEqual(["which", "dataset", "has", "invoice", "dates"]);
  });

  it("returns [] for punctuation-only input", () => {
    expect(tokenize("??? !!!")).toEqual([]);
  });
});

describe("chat rag — retrieveFacts", () => {
  it("retrieves the dataset whose column keywords match the question", () => {
    const hits = retrieveFacts("which dataset has invoice dates and gstin", INDEX);
    expect(hits[0]?.fact.id).toBe("d1");
  });

  it("ranks a title hit above a keyword-only hit", () => {
    const hits = retrieveFacts("payroll", INDEX);
    expect(hits[0]?.fact.id).toBe("d2");
  });

  it("matches artifacts by title", () => {
    const hits = retrieveFacts("show me the revenue overview dashboard", INDEX);
    expect(hits[0]?.fact.id).toBe("b1");
    expect(hits[0]?.fact.kind).toBe("dashboard");
  });

  it("returns [] when nothing matches", () => {
    expect(retrieveFacts("zeppelin quantum submarine", INDEX)).toEqual([]);
  });

  it("returns [] for an empty message or empty index", () => {
    expect(retrieveFacts("", INDEX)).toEqual([]);
    expect(retrieveFacts("anything", [])).toEqual([]);
  });

  it("caps results at the limit, best first", () => {
    const big = buildWorkspaceIndex({
      datasets: Array.from({ length: 10 }, (_, i) => ({
        id: `d${i}`,
        name: `data part-${i} shared.csv`,
        rowCount: i,
        columnCount: 2,
      })),
    });
    const hits = retrieveFacts("shared data", big, 3);
    expect(hits).toHaveLength(3);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("is deterministic across repeated calls", () => {
    const a = retrieveFacts("gst recon", INDEX);
    const b = retrieveFacts("gst recon", INDEX);
    expect(a).toEqual(b);
  });
});

describe("chat rag — buildWorkspaceIndex", () => {
  it("shapes datasets with human-readable row counts and keeps kinds", () => {
    const facts = buildWorkspaceIndex({
      datasets: [{ id: "x", name: "t.csv", rowCount: 1500, columnCount: 3 }],
      notebooks: [{ id: "n", title: "Cohort notebook" }],
      models: [{ id: "m", title: "Churn model", kind: "classification" }],
    });
    const ds = facts.find((f) => f.id === "x");
    expect(ds?.sub).toBe("1,500 rows × 3 columns");
    expect(facts.find((f) => f.id === "n")?.kind).toBe("notebook");
    const model = facts.find((f) => f.id === "m");
    expect(model?.kind).toBe("model");
    expect(model?.sub).toBe("classification");
  });
});

describe("chat rag — renderRagContext", () => {
  it("renders an empty string when there are no hits (honest default)", () => {
    expect(renderRagContext([])).toBe("");
  });

  it("renders facts with kinds and the no-row-data guard", () => {
    const hits = retrieveFacts("payroll", INDEX);
    const text = renderRagContext(hits);
    expect(text).toContain("[dataset] payroll.xlsx — 300 rows × 5 columns");
    expect(text).toContain("You have NOT read their row data");
    expect(text).toContain("never quote values");
  });
});
