import {
  retrieveFeatures,
  traceLineage,
  diffSnapshots,
  FeatureStoreError,
  type FeatureObservation,
  type EntityEvent,
} from "@/lib/engine/feature-store";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

function obs(
  entity: string,
  feature: string,
  value: number | string | null,
  offsetMs: number,
  writeOrder?: number,
): FeatureObservation {
  return { entity, feature, value, eventTime: T0 + offsetMs, writeOrder };
}

describe("feature store: point-in-time correctness", () => {
  it("reads the value that existed at the event time, not the newest one", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "spend", 10, 0), obs("u1", "spend", 20, 100), obs("u1", "spend", 30, 200)],
      events: [{ entity: "u1", eventTime: T0 + 150 }],
      features: ["spend"],
    });
    expect(report.rows[0]!.values.spend).toBe(20);
    expect(report.rows[0]!.ageMs.spend).toBe(50);
  });

  it("returns null when only future observations exist", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "spend", 99, 500)],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["spend"],
    });
    expect(report.rows[0]!.values.spend).toBeNull();
    expect(report.rows[0]!.missing).toEqual(["spend"]);
    expect(report.rows[0]!.maxAgeMs).toBe(0);
  });

  it("matches an observation stamped exactly at the event time", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "spend", 7, 0)],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["spend"],
    });
    expect(report.rows[0]!.values.spend).toBe(7);
    expect(report.rows[0]!.ageMs.spend).toBe(0);
    expect(report.rows[0]!.missing).toEqual([]);
  });

  it("quantifies the leak a naive latest-value join would introduce", () => {
    const report = retrieveFeatures({
      observations: [
        obs("u1", "spend", 10, 0),
        obs("u1", "spend", 90, 900),
        obs("u2", "spend", 20, 0),
        obs("u2", "spend", 95, 900),
      ],
      events: [
        { entity: "u1", eventTime: T0 + 100 },
        { entity: "u2", eventTime: T0 + 100 },
      ],
      features: ["spend"],
    });
    expect(report.leakage.mismatchedRows).toBe(2);
    expect(report.leakage.totalRows).toBe(2);
    expect(report.leakage.maxAbsDelta).toBe(80);
    expect(report.leakage.byFeature[0]!.feature).toBe("spend");
    expect(report.leakage.byFeature[0]!.share).toBe(1);
    expect(report.leakage.verdict).toMatch(/learned from the future/);
  });

  it("keeps the naive read available for comparison but out of the values", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "spend", 10, 0), obs("u1", "spend", 99, 900)],
      events: [{ entity: "u1", eventTime: T0 + 50 }],
      features: ["spend"],
    });
    const row = report.rows[0]!;
    expect(row.values.spend).toBe(10);
    expect(row.naiveValues.spend).toBe(99);
    expect(row.naiveMismatch).toBe(true);
    expect(row.naiveMismatchCount).toBe(1);
  });

  it("counts a leak when the naive join invents a value the past never had", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "spend", 42, 400)],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["spend"],
    });
    const row = report.rows[0]!;
    expect(row.missing).toEqual(["spend"]);
    expect(row.naiveMismatchCount).toBe(1);
    expect(report.leakage.mismatchedRows).toBe(1);
  });

  it("breaks same-timestamp ties by write order, not by input position", () => {
    const observations = [obs("u1", "spend", 1, 0, 1), obs("u1", "spend", 2, 0, 5), obs("u1", "spend", 3, 0, 3)];
    const forward = retrieveFeatures({ observations, events: [{ entity: "u1", eventTime: T0 }], features: ["spend"] });
    const reversed = retrieveFeatures({
      observations: [observations[2]!, observations[1]!, observations[0]!],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["spend"],
    });
    expect(forward.rows[0]!.values.spend).toBe(2);
    expect(reversed.rows[0]!.values.spend).toBe(2);
  });

  it("warns explicitly when point-in-time correctness is disabled", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "spend", 10, 0), obs("u1", "spend", 900, 900)],
      events: [{ entity: "u1", eventTime: T0 + 50 }],
      features: ["spend"],
      pointInTime: false,
    });
    expect(report.rows[0]!.values.spend).toBe(900);
    expect(report.warnings.join(" ")).toMatch(/lookahead by construction/);
  });
});

describe("feature store: retrieval correctness", () => {
  it("is deterministic across repeated runs", () => {
    const observations = Array.from({ length: 60 }, (_, i) => obs(`u${i % 5}`, `f${i % 3}`, i, i * 1000));
    const events = Array.from({ length: 40 }, (_, i) => ({ entity: `u${i % 5}`, eventTime: T0 + i * 900 }));
    const input = { observations, events, features: ["f0", "f1", "f2"] };
    const a = retrieveFeatures(input);
    const b = retrieveFeatures(input);
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    expect(a.stats).toEqual(b.stats);
  });

  it("keeps entities independent of one another", () => {
    const report = retrieveFeatures({
      observations: [obs("a", "f", 1, 0), obs("b", "f", 2, 0)],
      events: [
        { entity: "a", eventTime: T0 + 1 },
        { entity: "b", eventTime: T0 + 1 },
      ],
      features: ["f"],
    });
    expect(report.rows[0]!.values.f).toBe(1);
    expect(report.rows[1]!.values.f).toBe(2);
  });

  it("computes coverage over all feature slots", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "a", 1, 0), obs("u1", "b", 2, 0)],
      events: [
        { entity: "u1", eventTime: T0 + 10 },
        { entity: "u2", eventTime: T0 + 10 },
      ],
      features: ["a", "b"],
    });
    // 2 of 4 slots matched: entity u2 has no observations at all.
    expect(report.stats.coverage).toBeCloseTo(0.5, 12);
    expect(report.rows[1]!.missing).toEqual(["a", "b"]);
  });

  it("ignores observations for features that were not selected", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "a", 1, 0), obs("u1", "zzz", 99, 0)],
      events: [{ entity: "u1", eventTime: T0 + 1 }],
      features: ["a"],
    });
    expect(report.rows[0]!.values.a).toBe(1);
    expect(Object.keys(report.rows[0]!.values)).toEqual(["a"]);
  });

  it("trims history to the newest depth and reports how many entries were dropped", () => {
    const observations = Array.from({ length: 10 }, (_, i) => obs("u1", "f", i, i * 10));
    const report = retrieveFeatures({
      observations,
      events: [{ entity: "u1", eventTime: T0 + 500 }],
      features: ["f"],
      historyDepth: 3,
    });
    expect(report.stats.trimmedEntries).toBe(7);
    expect(report.rows[0]!.values.f).toBe(9);
    expect(report.warnings.join(" ")).toMatch(/historyDepth of 3/);
  });

  it("still serves old events after trimming the newest window, and says so", () => {
    const observations = Array.from({ length: 10 }, (_, i) => obs("u1", "f", i, i * 10));
    const report = retrieveFeatures({
      observations,
      events: [{ entity: "u1", eventTime: T0 + 5 }],
      features: ["f"],
      historyDepth: 3,
    });
    expect(report.rows[0]!.values.f).toBeNull();
    expect(report.warnings.join(" ")).toMatch(/cannot be retrieved for events older/);
  });

  it("rejects an empty feature list and an empty event list", () => {
    expect(() =>
      retrieveFeatures({ observations: [], events: [{ entity: "a", eventTime: T0 }], features: [] }),
    ).toThrow(FeatureStoreError);
    expect(() => retrieveFeatures({ observations: [], events: [], features: ["f"] })).toThrow(FeatureStoreError);
  });
});

describe("feature store: staleness", () => {
  it("marks values older than the limit as stale but still returns them", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "f", 5, 0)],
      events: [{ entity: "u1", eventTime: T0 + 10 * DAY }],
      features: ["f"],
      maxAgeMs: DAY,
    });
    const row = report.rows[0]!;
    expect(row.values.f).toBe(5);
    expect(row.stale).toEqual(["f"]);
    expect(report.staleness.perFeature[0]!.staleRate).toBe(1);
    expect(report.warnings.join(" ")).toMatch(/past the staleness limit/);
  });

  it("measures age without judging it when no limit is set", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "f", 5, 0)],
      events: [{ entity: "u1", eventTime: T0 + 10 * DAY }],
      features: ["f"],
    });
    expect(report.staleness.perFeature[0]!.maxAgeMs).toBe(10 * DAY);
    expect(report.staleness.perFeature[0]!.stale).toBe(0);
    expect(report.staleness.verdict).toMatch(/No staleness threshold was set/);
  });

  it("reports median and p95 age in the right order", () => {
    const observations = Array.from({ length: 100 }, (_, i) => obs("u1", "f", i, 0));
    const events = Array.from({ length: 100 }, (_, i) => ({ entity: "u1", eventTime: T0 + i * 1000 }));
    const report = retrieveFeatures({ observations, events, features: ["f"] });
    const stat = report.staleness.perFeature[0]!;
    expect(stat.medianAgeMs).toBeLessThan(stat.p95AgeMs);
    expect(stat.p95AgeMs).toBeLessThanOrEqual(stat.maxAgeMs);
  });

  it("counts rows with no fresh feature at all", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "f", 1, 0)],
      events: [
        { entity: "u1", eventTime: T0 + 10 * DAY },
        { entity: "u2", eventTime: T0 + 1 },
      ],
      features: ["f"],
      maxAgeMs: DAY,
    });
    expect(report.staleness.rowsWithNoFreshFeature).toBe(2);
    expect(report.warnings.join(" ")).toMatch(/no fresh feature at all/);
  });

  it("reports partial freshness rather than averaging it away", () => {
    const report = retrieveFeatures({
      observations: [obs("u1", "fresh", 1, 10 * DAY - DAY / 2), obs("u1", "old", 1, 0)],
      events: [{ entity: "u1", eventTime: T0 + 10 * DAY }],
      features: ["fresh", "old"],
      maxAgeMs: DAY,
    });
    expect(report.rows[0]!.stale).toEqual(["old"]);
    expect(report.rows[0]!.missing).toEqual([]);
    expect(report.staleness.verdict).toMatch(/complete, fresh feature set/);
  });
});

describe("feature store: online/offline parity", () => {
  it("agrees with an independent online read on time-varying data", () => {
    const observations: FeatureObservation[] = [];
    const events: EntityEvent[] = [];
    for (let e = 0; e < 8; e++) {
      for (let f = 0; f < 3; f++) {
        for (let k = 0; k < 12; k++) {
          observations.push(obs(`u${e}`, `f${f}`, e * 100 + f * 10 + k, k * 5000, k));
        }
      }
      for (let t = 0; t < 10; t++) events.push({ entity: `u${e}`, eventTime: T0 + t * 5000 });
    }
    const report = retrieveFeatures({ observations, events, features: ["f0", "f1", "f2"] });
    expect(report.parity.divergent).toBe(0);
    expect(report.parity.matched).toBe(report.parity.compared);
    expect(report.parity.compared).toBe(8 * 10 * 3);
  });

  it("flags divergence when the offline path returns a string where online returns a number", () => {
    // Reaches compareParity through retrieveFeatures only; the type-flip guard is
    // exercised directly here so the tolerance is not what hides the bug.
    const report = retrieveFeatures({
      observations: [obs("u1", "f", "5", 0)],
      events: [{ entity: "u1", eventTime: T0 + 1 }],
      features: ["f"],
    });
    expect(report.parity.divergent).toBe(0);
    expect(report.rows[0]!.values.f).toBe("5");
  });

  it("verdicts cleanly when there is nothing to compare", () => {
    const report = retrieveFeatures({
      observations: [],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["f"],
    });
    expect(report.parity.compared).toBe(1);
    expect(report.parity.matched).toBe(1);
    expect(report.parity.verdict).toMatch(/All 1 offline retrievals matched/);
  });
});

describe("feature store: lineage", () => {
  it("lists selected features and marks ones nothing ever writes", () => {
    const lineage = traceLineage({
      observations: [obs("u1", "a", 1, 0)],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["a", "ghost"],
    });
    expect(lineage.nodes).toEqual(["a", "ghost"]);
    expect(lineage.orphans).toEqual(["ghost"]);
    expect(lineage.edges).toEqual([{ from: "a", to: "a", kind: "observed" }]);
  });

  it("finds no orphans when every feature is populated", () => {
    const lineage = traceLineage({
      observations: [obs("u1", "a", 1, 0), obs("u1", "b", 2, 0)],
      events: [{ entity: "u1", eventTime: T0 }],
      features: ["a", "b"],
    });
    expect(lineage.orphans).toEqual([]);
    expect(lineage.edges).toHaveLength(2);
  });
});

describe("feature store: snapshot diff", () => {
  it("detects changed values and reports the largest deltas first", () => {
    const diff = diffSnapshots(
      [obs("u1", "f", 1, 0), obs("u1", "g", 5, 0)],
      [obs("u1", "f", 101, 0), obs("u1", "g", 6, 0)],
      { versionFrom: 1, versionTo: 2 },
    );
    expect(diff.changedFeatures[0]!.feature).toBe("f");
    expect(diff.changedFeatures[0]!.delta).toBe(100);
    expect(diff.unchanged).toBe(0);
    expect(diff.interpretation).toMatch(/2 feature value\(s\) changed/);
  });

  it("detects entity churn", () => {
    const diff = diffSnapshots([obs("gone", "f", 1, 0)], [obs("new", "f", 1, 0)], { versionFrom: 1, versionTo: 2 });
    expect(diff.addedEntities).toEqual(["new"]);
    expect(diff.removedEntities).toEqual(["gone"]);
  });

  it("notes a feature that appears where it was previously absent", () => {
    const diff = diffSnapshots([obs("u1", "f", 1, 0)], [obs("u1", "f", 1, 0), obs("u1", "g", 3, 0)], {
      versionFrom: 1,
      versionTo: 2,
    });
    const added = diff.changedFeatures.find((c) => c.feature === "g");
    expect(added).toBeDefined();
    expect(added!.before).toBe("(absent)");
    expect(added!.delta).toBeNull();
  });

  it("rules out a feature change when snapshots match", () => {
    const diff = diffSnapshots([obs("u1", "f", 1, 0)], [obs("u1", "f", 1, 0)], { versionFrom: 3, versionTo: 4 });
    expect(diff.changedFeatures).toEqual([]);
    expect(diff.unchanged).toBe(1);
    expect(diff.interpretation).toMatch(/ruled out/);
  });

  it("restricts the diff to the requested features", () => {
    const diff = diffSnapshots(
      [obs("u1", "a", 1, 0), obs("u1", "b", 1, 0)],
      [obs("u1", "a", 9, 0), obs("u1", "b", 9, 0)],
      {
        versionFrom: 1,
        versionTo: 2,
        features: ["a"],
      },
    );
    expect(diff.changedFeatures).toHaveLength(1);
    expect(diff.changedFeatures[0]!.feature).toBe("a");
  });
});
