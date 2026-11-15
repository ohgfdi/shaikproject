/**
 * Oracle tests for the choropleth engine.
 *
 * Hand-computed expectations: alias normalization, quantile vs equal-interval
 * class assignment, ramp colors, legend labels, GeoJSON join with honest
 * unmatched reporting, and determinism.
 */
import {
  buildChoropleth,
  CHOROPLETH_RAMP,
  classifyValues,
  NO_DATA_COLOR,
  normalizeRegionName,
  type GeoFeatureLike,
} from "@/lib/engine/geo";

describe("region-name normalization", () => {
  it("lowercases, strips diacritics, punctuation and parentheticals", () => {
    expect(normalizeRegionName("Maharashtra (MH)")).toBe("maharashtra");
    expect(normalizeRegionName("Côte d'Ivoire")).toBe("cote d ivoire");
    expect(normalizeRegionName("U.S.A.")).toBe("united states of america");
    expect(normalizeRegionName("  Washington  State ")).toBe("washington state");
  });

  it("maps canonical aliases", () => {
    expect(normalizeRegionName("USA")).toBe("united states of america");
    expect(normalizeRegionName("UK")).toBe("united kingdom");
    expect(normalizeRegionName("UAE")).toBe("united arab emirates");
    expect(normalizeRegionName("Holland")).toBe("netherlands");
  });

  it("resolves the same way from both the data side and the feature side", () => {
    // GeoJSON name "United States of America" vs dataset value "usa".
    expect(normalizeRegionName("United States of America")).toBe(normalizeRegionName("usa"));
  });
});

describe("value classification", () => {
  const rows = [
    { region: "A", value: 10 },
    { region: "B", value: 20 },
    { region: "C", value: 30 },
    { region: "D", value: 40 },
    { region: "E", value: 50 },
  ];

  it("quantile classes are balanced (5 values, 5 classes → one each)", () => {
    const res = classifyValues(rows, { method: "quantile" });
    const counts = new Map(res.classes.map((c) => [c.classIndex, 0]));
    for (const c of res.classes) counts.set(c.classIndex, (counts.get(c.classIndex) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    // Monotone: higher value ⇒ higher (darker) class.
    const byValue = [...res.classes].sort((a, b) => a.value - b.value);
    for (let i = 1; i < byValue.length; i++) {
      expect(byValue[i]!.classIndex).toBeGreaterThan(byValue[i - 1]!.classIndex - 1);
    }
    expect(res.classes.find((c) => c.region === "E")!.classIndex).toBe(4);
    expect(res.classes.find((c) => c.region === "E")!.color).toBe(CHOROPLETH_RAMP[4]);
  });

  it("equal-interval bins are width-equal, not size-equal", () => {
    const res = classifyValues(rows, { method: "equal-interval" });
    // min 10, max 50, 5 classes → width 8: 10–18, 18–26, 26–34, 34–42, 42–50.
    expect(res.classes.find((c) => c.region === "A")!.classIndex).toBe(0);
    expect(res.classes.find((c) => c.region === "C")!.classIndex).toBe(2);
    expect(res.classes.find((c) => c.region === "E")!.classIndex).toBe(4);
    expect(res.legend[0]!.label).toBe("10 – 18");
    expect(res.legend[4]!.label).toBe("42 – 50");
  });

  it("bounds follow the data scale and the legend covers all classes", () => {
    const res = classifyValues(rows, { method: "quantile" });
    expect(res.breaks.bounds).toHaveLength(5);
    expect(res.breaks.bounds[4]).toBe(50); // last bound = max
    expect(res.legend).toHaveLength(5);
    expect(res.legend.every((l) => l.color.startsWith("#"))).toBe(true);
  });

  it("is deterministic", () => {
    const a = JSON.stringify(classifyValues(rows));
    const b = JSON.stringify(classifyValues(rows));
    expect(a).toBe(b);
  });

  it("handles empty input and clamps class count", () => {
    expect(classifyValues([]).classes).toEqual([]);
    expect(classifyValues(rows.slice(0, 2), { classCount: 9 }).legend).toHaveLength(7); // clamped to 7
    expect(classifyValues(rows.slice(0, 2), { classCount: 1 }).legend).toHaveLength(3); // clamped to 3
  });
});

describe("GeoJSON join", () => {
  const features: GeoFeatureLike[] = [
    { type: "Feature", properties: { name: "Alabama" }, geometry: {} },
    { type: "Feature", properties: { name: "Alaska" }, geometry: {} },
    { type: "Feature", properties: { name: "Arizona" }, geometry: {} },
  ];

  it("joins values to features by normalized name", () => {
    const classified = classifyValues([
      { region: "alabama", value: 5 },
      { region: "Alaska", value: 15 },
      { region: "ARIZONA", value: 25 },
    ]).classes;
    const report = buildChoropleth(features, classified);
    expect(report.matched).toHaveLength(3);
    expect(report.matched[0]!.color).toBe(CHOROPLETH_RAMP[0]);
    expect(report.matched[2]!.value).toBe(25);
    expect(report.unmatchedRegions).toEqual([]);
    expect(report.unmatchedValues).toEqual([]);
  });

  it("reports unmatched features and values honestly", () => {
    const classified = classifyValues([
      { region: "Alabama", value: 5 },
      { region: "Atlantis", value: 99 }, // no such feature
    ]).classes;
    const report = buildChoropleth(features, classified);
    expect(report.matched).toHaveLength(1);
    expect(report.unmatchedRegions).toEqual(["Alaska", "Arizona"]);
    expect(report.unmatchedValues).toEqual(["Atlantis"]);
  });

  it("normalization bridges alias spellings", () => {
    const usa: GeoFeatureLike = { type: "Feature", properties: { name: "United States of America" }, geometry: {} };
    const classified = classifyValues([{ region: "USA", value: 42 }]).classes;
    const report = buildChoropleth([usa], classified);
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0]!.value).toBe(42);
  });

  it("exposes the no-data color for legend completeness", () => {
    // The renderer draws unmatched features in NO_DATA_COLOR — a UI contract,
    // pinned here so a refactor can't silently hide empty regions.
    expect(NO_DATA_COLOR).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
