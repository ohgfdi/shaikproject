import { generateExecutiveSummary } from "@/lib/analytics/executive-summary";
import {
  generateSalesDataset,
  generateMarketingDataset,
  csvStringify,
  toNdjson,
  SAMPLE_DATASETS,
} from "@/lib/analytics/sample-data";

// Mock the heavy dependencies
jest.mock("@/lib/db", () => ({
  prisma: {
    dataset: {
      findUnique: jest.fn().mockResolvedValue({
        id: "test-dataset",
        name: "sales_data",
        columns: JSON.stringify([
          { name: "transaction_id", type: "string" },
          { name: "date", type: "date" },
          { name: "product", type: "string" },
          { name: "region", type: "string" },
          { name: "quantity", type: "number" },
          { name: "revenue", type: "number" },
          { name: "cost", type: "number" },
          { name: "profit", type: "number" },
        ]),
      }),
    },
  },
}));

jest.mock("@/lib/engine/dataset", () => ({
  loadParsedDataset: jest.fn().mockImplementation(() => {
    // requireActual avoids the hoisting cycle between sample-data and the mock
    // (a static import would be hoisted above jest.mock).
    const { generateSalesDataset } =
      jest.requireActual<typeof import("@/lib/analytics/sample-data")>("@/lib/analytics/sample-data");
    return Promise.resolve({
      rows: generateSalesDataset(3, 20).rows,
      totalRows: 60,
    });
  }),
}));

jest.mock("@/lib/env", () => ({
  serverEnv: () => ({ DATASET_ANALYSIS_LIMIT: 50000 }),
}));

describe("Executive Summary Generator", () => {
  it("produces an honest, evidence-backed summary", async () => {
    const summary = await generateExecutiveSummary("test-dataset");

    expect(summary.metadata.totalRows).toBe(60);
    expect(summary.metadata.totalColumns).toBe(8);
    expect(summary.sections.length).toBeGreaterThanOrEqual(4);
    expect(summary.keyFindings.length).toBeGreaterThan(0);

    // Every section must have real evidence
    for (const section of summary.sections) {
      expect(section.confidence).toBeGreaterThan(0);
      expect(section.evidence.length).toBeGreaterThan(0);
      expect(section.content).toBeTruthy();
    }

    // Honesty: limitations sections must be present when data is limited
    expect(summary.limitations.length).toBeGreaterThan(0);
  });

  it("reports the real dataset name and correct metadata", async () => {
    const summary = await generateExecutiveSummary("test-dataset");
    expect(summary.datasetName).toBe("sales_data");
    expect(summary.datasetId).toBe("test-dataset");
  });
});

describe("Sample Data Generator", () => {
  it("generates deterministic sales data", () => {
    const a = generateSalesDataset(2, 10);
    const b = generateSalesDataset(2, 10);
    expect(a.rows).toEqual(b.rows); // Same seed → same data
    expect(a.rows.length).toBe(20);
    expect(a.columns.some((c) => c.name === "revenue")).toBe(true);
    expect(a.columns.some((c) => c.name === "date")).toBe(true);
  });

  it("generates realistic revenue values", () => {
    const sales = generateSalesDataset(1, 50).rows;
    const revenues = sales.map((r) => Number(r.revenue));
    expect(Math.min(...revenues)).toBeGreaterThan(0);
    expect(sales.every((r) => r.date && typeof r.date === "string")).toBe(true);
  });

  it("generates valid marketing data with conversion metrics", () => {
    const marketing = generateMarketingDataset(1, 25).rows;
    expect(marketing.length).toBe(25);
    expect(marketing.every((r) => typeof r.conversions === "number")).toBe(true);
    // CTR must be a real fraction
    expect(marketing.every((r) => Number(r.ctr) >= 0 && Number(r.ctr) <= 1)).toBe(true);
  });

  it("serializes to valid CSV and NDJSON", () => {
    const sales = generateSalesDataset(1, 5);
    const csv = csvStringify(sales.rows);
    expect(csv.split("\n").length).toBe(6); // header + 5 rows
    expect(csv.includes("transaction_id")).toBe(true);
    expect(csv.includes("revenue")).toBe(true);

    const ndjson = toNdjson(sales.rows);
    const lines = ndjson.trim().split("\n");
    expect(lines.length).toBe(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("registers all four sample kinds", () => {
    expect(Object.keys(SAMPLE_DATASETS)).toEqual(expect.arrayContaining(["sales", "marketing", "web_analytics", "hr"]));
  });
});
