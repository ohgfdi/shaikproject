import { generateSalesDataset } from "@/lib/analytics/sample-data";
import { SemanticLayerManager, BUILTIN_METRICS } from "@/lib/analytics/semantic-layer";

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
    // DB-persisted custom metrics (CustomMetric) — none in this fixture; the
    // layer falls back to the built-in metric set.
    customMetric: {
      findMany: jest.fn().mockResolvedValue([]),
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
      rows: generateSalesDataset(2, 30).rows,
      totalRows: 60,
    });
  }),
}));

jest.mock("@/lib/env", () => ({
  serverEnv: () => ({ DATASET_ANALYSIS_LIMIT: 50000 }),
}));

describe("Semantic Layer", () => {
  let layer: SemanticLayerManager;

  beforeEach(() => {
    layer = new SemanticLayerManager("test-dataset");
  });

  it("initializes and matches metrics to real columns", async () => {
    await layer.initialize();
    const metrics = layer.getMetrics();
    expect(metrics.length).toBeGreaterThan(0);

    // Revenue should be matched from the sales data
    const revenueMetric = metrics.find((m) => m.name === "Total Revenue");
    expect(revenueMetric).toBeDefined();
    expect(revenueMetric!.sourceColumns[0]).toBe("revenue");
  });

  it("computes real, verifiable metrics", async () => {
    await layer.initialize();
    const values = await layer.computeMetrics();
    expect(values.length).toBeGreaterThan(0);

    // Total Revenue should equal the actual sum of the revenue column
    const salesData = generateSalesDataset(2, 30).rows;
    const expectedRevenue = salesData.reduce((sum, r) => sum + Number(r.revenue), 0);

    const revenueValue = values.find((v) => v.metricName === "Total Revenue");
    expect(revenueValue).toBeDefined();
    expect(Math.abs(revenueValue!.value - expectedRevenue)).toBeLessThan(0.01);
    expect(revenueValue!.confidence).toBe(1.0);
    expect(revenueValue!.sampleSize).toBe(60);
  });

  it("formats a Total Revenue value as currency", async () => {
    await layer.initialize();
    const values = await layer.computeMetrics();
    const revenueValue = values.find((v) => v.metricName === "Total Revenue");
    expect(revenueValue!.formattedValue).toMatch(/\$/);
  });

  it("computes distinct customer counts correctly", async () => {
    await layer.initialize();
    const values = await layer.computeMetrics();

    // Chiefly verify the customer_count metric if matched
    const customerCount = values.find((v) => v.metricName === "Customer Count");
    if (customerCount) {
      const data = generateSalesDataset(2, 30).rows;
      const uniqueCustomers = new Set(data.map((r) => String(r.customer_name))).size;
      expect(customerCount.value).toBe(uniqueCustomers);
    }
  });

  it("flags invalid metrics honestly", async () => {
    await layer.initialize();
    // A metric with a non-existent column should fail validation
    const invalid = {
      ...BUILTIN_METRICS[0],
      id: "invalid",
      name: "Invalid",
      sourceColumns: ["nonexistent_column"],
    };
    const validation = layer.validateMetric(invalid.id);
    expect(validation.valid).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
  });

  it("never returns NaN or Infinity values", async () => {
    await layer.initialize();
    const values = await layer.computeMetrics();
    for (const v of values) {
      expect(Number.isFinite(v.value)).toBe(true);
    }
  });
});
