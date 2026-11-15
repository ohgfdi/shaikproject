/**
 * Statute & notification rule registry — oracle tests.
 *
 * These pin the properties a filing-grade registry has to guarantee:
 *  1. Normalisation is deterministic — re-ingesting the same item is a no-op
 *     (same contentHash) and an edited item is detectable.
 *  2. Effective dates are only ever *proposed* from the text, never invented.
 *  3. A rule version applies only inside its [effectiveFrom, effectiveTo)
 *     window; drafts and superseded versions never resolve.
 *  4. Resolution is deterministic: most specific applicability wins, then the
 *     newest effectiveFrom, then the highest version.
 *  5. A resolved version converts to the exact RateTable the compute engines
 *     consume (and registers cleanly into ca-rate-registry).
 */

import { getRateTable, registerOverride, RateRegistryError } from "@/lib/engine/ca-rate-registry";
import {
  RULE_CATALOG,
  applicabilityMatches,
  compareApplicabilitySpecificity,
  diffRuleVersions,
  extractEffectiveDates,
  hashRuleVersion,
  impactedRuleKeys,
  inferAuthority,
  inferNotificationKind,
  isKnownRuleKey,
  normalizeNotification,
  rateTablesFromVersions,
  resolveRuleVersion,
  ruleDefinition,
  rulesInForce,
  ruleVersionsForRule,
  toRateTable,
  validateRuleVersionInput,
  type RuleVersionRecord,
} from "@/lib/engine/statutes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function version(over: Partial<RuleVersionRecord> & Pick<RuleVersionRecord, "ruleKey">): RuleVersionRecord {
  const applicability = over.applicability ?? { ay: "2026-27", entityTypes: [], states: [], scope: "central" as const };
  const unit = over.unit ?? "bps";
  const rows = over.rows ?? [{ upTo: null, rate: 2200 }];
  const citation = over.citation ?? "Finance Act 2026";
  const effectiveFrom = over.effectiveFrom ?? "2026-04-01";
  const effectiveTo = over.effectiveTo ?? null;
  const valueSummary = over.valueSummary ?? "22%";
  return {
    id: over.id ?? `${over.ruleKey}-v${over.version ?? 1}`,
    ruleKey: over.ruleKey,
    version: over.version ?? 1,
    applicability,
    unit,
    rows,
    valueSummary,
    citation,
    effectiveFrom,
    effectiveTo,
    status: over.status ?? "published",
    notificationId: over.notificationId ?? null,
    supersedes: over.supersedes ?? null,
    contentHash:
      over.contentHash ??
      hashRuleVersion({
        ruleKey: over.ruleKey,
        applicability,
        unit,
        rows,
        citation,
        effectiveFrom,
        effectiveTo,
        valueSummary,
      }),
    createdAt: over.createdAt ?? "2026-04-01T00:00:00.000Z",
    publishedAt: over.publishedAt ?? "2026-04-01T00:00:00.000Z",
    publishedBy: over.publishedBy ?? "user-1",
    notes: over.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe("rule catalogue", () => {
  it("labels every slot with an authority and cadence", () => {
    expect(RULE_CATALOG.length).toBeGreaterThan(10);
    for (const def of RULE_CATALOG) {
      expect(def.key).toMatch(/^[a-z0-9-]+$/);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.authority.length).toBeGreaterThan(0);
      expect(["annual", "quarterly", "ad-hoc"]).toContain(def.cadence);
    }
  });

  it("covers the gap's named rule families", () => {
    for (const key of [
      "income-tax-slab-new",
      "surcharge",
      "cess",
      "tds-section-rate",
      "gst-rate",
      "audit-turnover-limit-44ab",
      "msme-43bh-window-days",
      "roc-aoc4-due-days",
      "roc-mgt7-due-days",
      "professional-tax-slab",
    ]) {
      expect(isKnownRuleKey(key)).toBe(true);
    }
  });

  it("throws for an unknown slot instead of guessing", () => {
    expect(isKnownRuleKey("nope")).toBe(false);
    expect(() => ruleDefinition("nope")).toThrow(/Unknown rule/);
  });
});

// ---------------------------------------------------------------------------
// Notification normalisation
// ---------------------------------------------------------------------------

describe("inferAuthority", () => {
  it("prefers an explicit authority", () => {
    expect(inferAuthority({ sourceKey: "x", title: "t", url: "https://example.com", authority: "mca" })).toBe("mca");
  });

  it("infers from the publishing host", () => {
    expect(inferAuthority({ sourceKey: "x", title: "t", url: "https://www.incometax.gov.in/abc" })).toBe("cbdt");
    expect(inferAuthority({ sourceKey: "x", title: "t", url: "https://www.cbic.gov.in/abc" })).toBe("cbic");
    expect(inferAuthority({ sourceKey: "x", title: "t", url: "https://www.mca.gov.in/abc" })).toBe("mca");
  });

  it("falls back to title keywords, then other", () => {
    expect(inferAuthority({ sourceKey: "x", title: "CBDT circular on TDS", url: "" })).toBe("cbdt");
    expect(inferAuthority({ sourceKey: "x", title: "Company law update", url: "" })).toBe("mca");
    expect(inferAuthority({ sourceKey: "x", title: "Misc notice", url: "" })).toBe("other");
  });
});

describe("inferNotificationKind", () => {
  it("classifies the item kind from the title", () => {
    expect(inferNotificationKind("Circular No. 5/2026")).toBe("circular");
    expect(inferNotificationKind("Press Release on GST")).toBe("press-release");
    expect(inferNotificationKind("Amendment to Rule 8")).toBe("amendment");
    expect(inferNotificationKind("Order under s.119")).toBe("order");
    expect(inferNotificationKind("Notification No. 12/2026")).toBe("notification");
  });
});

describe("extractEffectiveDates", () => {
  it("reads ISO dates", () => {
    expect(extractEffectiveDates("effective from 2026-04-01").effectiveFrom).toBe("2026-04-01");
  });

  it("reads dd.mm.yyyy (the common CBDT form)", () => {
    expect(extractEffectiveDates("w.e.f. 01.04.2026").effectiveFrom).toBe("2026-04-01");
  });

  it("reads 'D Month YYYY' and 'Month D, YYYY'", () => {
    expect(extractEffectiveDates("with effect from 1 April 2026").effectiveFrom).toBe("2026-04-01");
    expect(extractEffectiveDates("applicable from April 1, 2026").effectiveFrom).toBe("2026-04-01");
  });

  it("reads an explicit window end", () => {
    const dates = extractEffectiveDates("with effect from 1 April 2026 and up to 31 March 2027");
    expect(dates.effectiveFrom).toBe("2026-04-01");
    expect(dates.effectiveTo).toBe("2027-03-31");
  });

  it("rejects impossible calendar days instead of rolling them over", () => {
    expect(extractEffectiveDates("w.e.f. 31.02.2026").effectiveFrom).toBeNull();
  });

  it("returns nulls when no date is stated (never invents one)", () => {
    const dates = extractEffectiveDates("The Board clarifies the procedure.");
    expect(dates.effectiveFrom).toBeNull();
    expect(dates.effectiveTo).toBeNull();
  });
});

describe("impactedRuleKeys", () => {
  it("matches catalogue slots from the text", () => {
    const keys = impactedRuleKeys(
      "This notification prescribes the new slab rates under the new regime and the surcharge payable.",
    );
    expect(keys).toContain("income-tax-slab-new");
    expect(keys).toContain("surcharge");
  });

  it("returns nothing for unrelated text", () => {
    expect(impactedRuleKeys("Office holiday list for the assessment year")).toEqual([]);
  });
});

describe("normalizeNotification", () => {
  const raw = {
    sourceKey: "cbdt-notifications",
    externalId: "12/2026",
    title: "Notification No. 12/2026 — TDS rate under section 194C",
    url: "https://www.incometax.gov.in/notifications/12-2026",
    publishedAt: "2026-03-30",
    bodyText: "With effect from 1 April 2026 the rate of deduction under section 194C is 2 per cent.",
  };

  it("normalises a raw feed item into the canonical shape", () => {
    const parsed = normalizeNotification(raw);
    expect(parsed.authority).toBe("cbdt");
    expect(parsed.kind).toBe("notification");
    expect(parsed.effectiveFrom).toBe("2026-04-01");
    expect(parsed.impactedRuleKeys).toContain("tds-section-rate");
    expect(parsed.reviewRequired).toBe(true);
    expect(parsed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — the same item hashes identically (idempotent re-ingest)", () => {
    expect(normalizeNotification(raw).contentHash).toBe(normalizeNotification(raw).contentHash);
  });

  it("detects an edited item via a different hash", () => {
    const edited = normalizeNotification({ ...raw, bodyText: `${raw.bodyText} The threshold is also revised.` });
    expect(edited.contentHash).not.toBe(normalizeNotification(raw).contentHash);
  });

  it("warns (but does not fail) when the text has no date or matched slot", () => {
    const parsed = normalizeNotification({ sourceKey: "s", title: "Miscellaneous clarifications", url: "" });
    expect(parsed.effectiveFrom).toBeNull();
    expect(parsed.warnings.join(" ")).toMatch(/effective date/i);
    expect(parsed.warnings.join(" ")).toMatch(/catalogue slot/i);
  });

  it("rejects a notification without a title or with a non-http URL", () => {
    expect(() => normalizeNotification({ sourceKey: "s", title: "  ", url: "" })).toThrow(/needs a title/);
    expect(() => normalizeNotification({ sourceKey: "s", title: "t", url: "ftp://x" })).toThrow(/http\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// Rule-version validation
// ---------------------------------------------------------------------------

describe("validateRuleVersionInput", () => {
  const base = {
    ruleKey: "cess",
    applicability: { ay: "2026-27", entityTypes: [], states: [], scope: "central" as const },
    unit: "bps" as const,
    rows: [{ upTo: null, rate: 400 }],
    valueSummary: "Health & education cess 4%",
    citation: "Finance Act 2026",
    effectiveFrom: "2026-04-01",
  };

  it("accepts a well-formed version", () => {
    expect(() => validateRuleVersionInput(base)).not.toThrow();
  });

  it("rejects an unknown rule key", () => {
    expect(() => validateRuleVersionInput({ ...base, ruleKey: "nope" })).toThrow(/Unknown rule/);
  });

  it("rejects malformed dates and an empty window", () => {
    expect(() => validateRuleVersionInput({ ...base, effectiveFrom: "2026" })).toThrow(/yyyy-mm-dd/);
    expect(() => validateRuleVersionInput({ ...base, effectiveFrom: "2026-04-01", effectiveTo: "2026-04-01" })).toThrow(
      /window is empty/,
    );
  });

  it("requires a summary and a citation", () => {
    expect(() => validateRuleVersionInput({ ...base, valueSummary: " " })).toThrow(/value summary/);
    expect(() => validateRuleVersionInput({ ...base, citation: "" })).toThrow(/citation/);
  });

  it("requires rows in ascending order with at most one open-ended row, last", () => {
    expect(() => validateRuleVersionInput({ ...base, rows: [] })).toThrow(/at least one row/);
    expect(() =>
      validateRuleVersionInput({
        ...base,
        rows: [
          { upTo: null, rate: 1 },
          { upTo: 100, rate: 2 },
        ],
      }),
    ).toThrow(/LAST row/);
    expect(() =>
      validateRuleVersionInput({
        ...base,
        rows: [
          { upTo: 500, rate: 1 },
          { upTo: 400, rate: 2 },
        ],
      }),
    ).toThrow(/strictly increase/);
  });

  it("requires states on a state-scoped rule", () => {
    expect(() =>
      validateRuleVersionInput({
        ...base,
        applicability: { ay: "2026-27", entityTypes: [], states: [], scope: "state" },
      }),
    ).toThrow(/state code/i);
  });
});

// ---------------------------------------------------------------------------
// Applicability + resolution
// ---------------------------------------------------------------------------

describe("applicabilityMatches", () => {
  it("treats empty entityTypes/states as 'any'", () => {
    const a = { ay: "2026-27", entityTypes: [], states: [], scope: "central" as const };
    expect(applicabilityMatches(a, { ay: "2026-27" })).toBe(true);
    expect(applicabilityMatches(a, { ay: "2025-26" })).toBe(false);
    expect(applicabilityMatches(a, {})).toBe(false); // AY-scoped rule needs an AY
  });

  it("requires the named entity/state to be asked for", () => {
    const a = { ay: null, entityTypes: ["company"], states: ["MH"], scope: "state" as const };
    expect(applicabilityMatches(a, { entityType: "company", state: "MH" })).toBe(true);
    expect(applicabilityMatches(a, { entityType: "individual", state: "MH" })).toBe(false);
    expect(applicabilityMatches(a, { entityType: "company", state: "KA" })).toBe(false);
  });
});

describe("compareApplicabilitySpecificity", () => {
  it("ranks state-specific over all-India and named-entity over generic", () => {
    const central = { ay: null, entityTypes: [], states: [], scope: "central" as const };
    const state = { ay: null, entityTypes: [], states: ["MH"], scope: "state" as const };
    const entity = { ay: null, entityTypes: ["company"], states: [], scope: "central" as const };
    expect(compareApplicabilitySpecificity(state, central)).toBeGreaterThan(0);
    expect(compareApplicabilitySpecificity(entity, central)).toBeGreaterThan(0);
    expect(compareApplicabilitySpecificity(state, entity)).toBeGreaterThan(0);
  });
});

describe("resolveRuleVersion", () => {
  const older = version({
    ruleKey: "cess",
    version: 1,
    effectiveFrom: "2020-04-01",
    effectiveTo: "2026-04-01",
    valueSummary: "old 1%",
  });
  const current = version({
    ruleKey: "cess",
    version: 2,
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    valueSummary: "4%",
  });

  it("applies the effective window inclusively at the start", () => {
    expect(
      resolveRuleVersion([older, current], { ruleKey: "cess", asOn: "2026-04-01", ay: "2026-27" })?.version.version,
    ).toBe(2);
  });

  it("applies the window exclusively at the end (the day the next version starts)", () => {
    expect(
      resolveRuleVersion([older, current], { ruleKey: "cess", asOn: "2026-03-31", ay: "2026-27" })?.version.version,
    ).toBe(1);
  });

  it("returns null when nothing is in force (no silent fallback)", () => {
    expect(resolveRuleVersion([current], { ruleKey: "cess", asOn: "2020-01-01", ay: "2026-27" })).toBeNull();
  });

  it("never resolves drafts or superseded versions", () => {
    const draft = version({ ruleKey: "cess", version: 3, effectiveFrom: "2026-04-01", status: "draft" });
    const superseded = version({ ruleKey: "cess", version: 2, effectiveFrom: "2026-04-01", status: "superseded" });
    expect(resolveRuleVersion([draft, superseded], { ruleKey: "cess", asOn: "2026-05-01", ay: "2026-27" })).toBeNull();
  });

  it("prefers the most specific applicability (state over all-India)", () => {
    const allIndia = version({
      ruleKey: "professional-tax-slab",
      version: 1,
      applicability: { ay: null, entityTypes: [], states: [], scope: "central" },
      valueSummary: "generic",
    });
    const maharashtra = version({
      ruleKey: "professional-tax-slab",
      version: 2,
      applicability: { ay: null, entityTypes: [], states: ["MH"], scope: "state" },
      valueSummary: "MH slabs",
    });
    const resolved = resolveRuleVersion([allIndia, maharashtra], {
      ruleKey: "professional-tax-slab",
      asOn: "2026-05-01",
      state: "MH",
    });
    expect(resolved?.version.version).toBe(2);
    expect(resolved?.alternatives.map((v) => v.version)).toContain(1);
  });

  it("breaks ties on the newest effectiveFrom, then the highest version", () => {
    const a = version({ ruleKey: "cess", version: 9, effectiveFrom: "2026-04-01" });
    const b = version({ ruleKey: "cess", version: 10, effectiveFrom: "2027-04-01" });
    expect(resolveRuleVersion([a, b], { ruleKey: "cess", asOn: "2027-05-01", ay: "2026-27" })?.version.version).toBe(
      10,
    );

    const sameDay1 = version({ ruleKey: "cess", id: "x1", version: 4, effectiveFrom: "2026-04-01" });
    const sameDay2 = version({ ruleKey: "cess", id: "x2", version: 5, effectiveFrom: "2026-04-01" });
    expect(
      resolveRuleVersion([sameDay1, sameDay2], { ruleKey: "cess", asOn: "2026-04-02", ay: "2026-27" })?.version.version,
    ).toBe(5);
  });

  it("returns a human-readable reason for the audit trail", () => {
    const resolved = resolveRuleVersion([current], { ruleKey: "cess", asOn: "2026-05-01", ay: "2026-27" });
    expect(resolved?.reason).toMatch(/v2 in force from 2026-04-01/);
  });

  it("rejects a malformed asOn", () => {
    expect(() => resolveRuleVersion([current], { ruleKey: "cess", asOn: "01-04-2026" })).toThrow(/asOn/);
  });
});

describe("ruleVersionsForRule / rulesInForce", () => {
  const v1 = version({ ruleKey: "cess", version: 1, effectiveFrom: "2020-04-01" });
  const v2 = version({ ruleKey: "cess", version: 2, effectiveFrom: "2026-04-01" });
  const corp = version({ ruleKey: "corporate-rate", version: 1, effectiveFrom: "2026-04-01" });

  it("lists a rule's versions newest first", () => {
    expect(ruleVersionsForRule([v1, v2, corp], "cess").map((v) => v.version)).toEqual([2, 1]);
  });

  it("returns one in-force version per rule for an as-on date", () => {
    const inForce = rulesInForce([v1, v2, corp], "2026-05-01", { ay: "2026-27" });
    expect(inForce.map((v) => `${v.ruleKey}:v${v.version}`).sort()).toEqual(["cess:v2", "corporate-rate:v1"]);
  });
});

describe("diffRuleVersions", () => {
  it("reports added, removed and changed rows plus the value change", () => {
    const before = version({
      ruleKey: "cess",
      version: 1,
      rows: [
        { upTo: 5_00_000, rate: 0 },
        { upTo: null, rate: 100 },
      ],
      valueSummary: "old",
    });
    const after = version({
      ruleKey: "cess",
      version: 2,
      rows: [
        { upTo: 5_00_000, rate: 0 },
        { upTo: 10_00_000, rate: 200 },
      ],
      valueSummary: "new",
    });
    const diff = diffRuleVersions(before, after);
    expect(diff.valueChanged).toBe(true);
    expect(diff.rowsChanged).toEqual([{ before: { upTo: null, rate: 100 }, after: { upTo: 10_00_000, rate: 200 } }]);
    expect(diff.from?.version).toBe(1);
    expect(diff.to?.version).toBe(2);
  });

  it("treats an introduction (no previous) as a change", () => {
    const diff = diffRuleVersions(null, version({ ruleKey: "cess" }));
    expect(diff.from).toBeNull();
    expect(diff.valueChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bridge to the compute engines
// ---------------------------------------------------------------------------

describe("toRateTable bridge", () => {
  it("converts a published rate version into the engine RateTable", () => {
    const v = version({
      ruleKey: "corporate-rate",
      unit: "bps",
      applicability: { ay: "2026-27", entityTypes: [], states: [], scope: "central" },
      rows: [{ upTo: null, rate: 2200 }],
      citation: "Finance Act 2026",
      valueSummary: "22%",
      effectiveFrom: "2026-04-01",
    });
    const table = toRateTable(v);
    expect(table.kind).toBe("corporate-rate");
    expect(table.ay).toBe("2026-27");
    expect(table.unit).toBe("bps");
    expect(table.rows).toEqual([{ upTo: null, rate: 2200 }]);
    expect(table.source).toContain("Finance Act 2026");
    expect(table.asOn).toBe("2026-04-01");
  });

  it("refuses a non-rate rule (a due-date window is not a rate table)", () => {
    expect(() =>
      toRateTable(version({ ruleKey: "roc-aoc4-due-days", unit: "days", rows: [{ upTo: null, rate: 30 }] })),
    ).toThrow(/not a rate table/);
  });

  it("only yields tables for rate-kind rules", () => {
    const tables = rateTablesFromVersions([
      version({ ruleKey: "cess" }),
      version({ ruleKey: "roc-mgt7-due-days", unit: "days" }),
    ]);
    expect(tables.map((t) => t.ruleKey)).toEqual(["cess"]);
  });

  it("registers into ca-rate-registry so the engines consume the registry value", () => {
    const v = version({
      ruleKey: "cess",
      unit: "bps",
      applicability: { ay: "2031-32", entityTypes: [], states: [], scope: "central" },
      rows: [{ upTo: null, rate: 500 }],
      effectiveFrom: "2031-04-01",
    });
    registerOverride(toRateTable(v));
    const { table, overridden } = getRateTable("2031-32", "cess");
    expect(overridden).toBe(true);
    expect(table.rows).toEqual([{ upTo: null, rate: 500 }]);
  });

  it("still throws for an unregistered AY (no cross-year fallback)", () => {
    expect(() => getRateTable("2099-00", "cess")).toThrow(RateRegistryError);
  });
});
