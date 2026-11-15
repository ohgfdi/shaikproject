/**
 * Template marketplace — categories, versioning, sharing.
 * The marketplace layer is derived from the catalog; these tests pin the
 * derivation so a catalog edit can't silently break the gallery.
 */

import { ANALYSIS_TEMPLATES } from "@/lib/engine/template-catalog";
import {
  CATEGORY_RULES,
  bumpVersion,
  categorize,
  compareVersions,
  formatVersion,
  marketplaceEntries,
  mostInstalled,
  parseShareToken,
  parseVersion,
  rankByInstalls,
  shareLink,
  shareToken,
  templatesInCategory,
} from "@/lib/engine/template-marketplace";

describe("marketplace — categories", () => {
  it("derives at least one category for every catalog template", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      expect(categorize(t).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("maps each pack to its intended category", () => {
    const gst = ANALYSIS_TEMPLATES.find((t) => t.id === "gst-recon-summary")!;
    const tally = ANALYSIS_TEMPLATES.find((t) => t.id === "tally-trial-balance")!;
    const bank = ANALYSIS_TEMPLATES.find((t) => t.id === "bank-statement-cashflow")!;
    const audit = ANALYSIS_TEMPLATES.find((t) => t.id === "audit-journal-risk")!;
    expect(categorize(gst)).toContain("compliance");
    expect(categorize(tally)).toContain("bookkeeping");
    expect(categorize(bank)).toContain("cash");
    expect(categorize(audit)).toContain("audit");
  });

  it("puts every starter-level template in the starter category", () => {
    for (const t of ANALYSIS_TEMPLATES.filter((t) => t.level === "starter")) {
      expect(categorize(t)).toContain("starter");
    }
  });

  it("every category rule has a label, description and predicate", () => {
    for (const rule of CATEGORY_RULES) {
      expect(rule.label.length).toBeGreaterThan(3);
      expect(rule.description.length).toBeGreaterThan(10);
      expect(typeof rule.matches).toBe("function");
    }
  });

  it("templatesInCategory returns sorted, catalog-backed results", () => {
    const compliance = templatesInCategory("compliance");
    expect(compliance.length).toBeGreaterThanOrEqual(1);
    for (const t of compliance) {
      expect(t.pack).toBe("gst");
    }
    // unknown ids fall back to "all"
    expect(templatesInCategory("bogus" as never).length).toBe(ANALYSIS_TEMPLATES.length);
  });
});

describe("marketplace — versioning", () => {
  it("parses strict semver strings and rejects junk", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("v1.2.3")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
  });

  it("compares numerically on each part (no string-comparison traps)", () => {
    expect(compareVersions(parseVersion("1.2.9")!, parseVersion("1.3.0")!)).toBe(-1);
    expect(compareVersions(parseVersion("2.0.0")!, parseVersion("1.99.99")!)).toBe(1);
    expect(compareVersions(parseVersion("1.0.10")!, parseVersion("1.0.9")!)).toBe(1); // "10" > "9"
    expect(compareVersions(parseVersion("1.0.0")!, parseVersion("1.0.0")!)).toBe(0);
  });

  it("bumps follow semver rules", () => {
    expect(bumpVersion(parseVersion("1.2.3")!, "patch")).toEqual({ major: 1, minor: 2, patch: 4 });
    expect(bumpVersion(parseVersion("1.2.3")!, "minor")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(bumpVersion(parseVersion("1.2.3")!, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it("formats losslessly", () => {
    expect(formatVersion({ major: 12, minor: 0, patch: 7 })).toBe("12.0.7");
  });

  it("registers a version for every catalog template (unregistered → 1.0.0)", () => {
    const entries = marketplaceEntries();
    expect(entries).toHaveLength(ANALYSIS_TEMPLATES.length);
    for (const e of entries) {
      expect(e.version).toMatchObject({
        major: expect.any(Number),
        minor: expect.any(Number),
        patch: expect.any(Number),
      });
    }
  });
});

describe("marketplace — sharing", () => {
  it("produces stable, url-safe tokens", () => {
    const v = parseVersion("1.2.0")!;
    const token = shareToken("gst-recon-summary", v);
    expect(token).toMatch(/^t-[a-z0-9]+$/);
    expect(shareToken("gst-recon-summary", v)).toBe(token); // deterministic
    expect(shareToken("gst-recon-summary", parseVersion("1.2.1")!)).not.toBe(token); // version-sensitive
  });

  it("parses a share token back to the template id; junk → null", () => {
    const entries = marketplaceEntries();
    const first = entries[0]!;
    expect(parseShareToken(shareToken(first.template.id, first.version))).toBe(first.template.id);
    expect(parseShareToken("t-doesnotexist")).toBeNull();
    expect(parseShareToken(null)).toBeNull();
    expect(parseShareToken("garbage")).toBeNull();
  });

  it("builds a deep link carrying the ref", () => {
    const v = parseVersion("1.0.0")!;
    expect(shareLink("gst-rate-mix", v)).toBe(`/templates/gst-rate-mix?ref=${shareToken("gst-rate-mix", v)}`);
  });
});

describe("marketplace — installs", () => {
  const entries = marketplaceEntries();

  it("ranks by install count desc, catalog order for ties", () => {
    const ranked = rankByInstalls(entries, [
      { templateId: "gst-rate-mix", at: new Date().toISOString() },
      { templateId: "gst-rate-mix", at: new Date().toISOString() },
      { templateId: "gst-recon-summary", at: new Date().toISOString() },
    ]);
    expect(ranked[0]).toEqual({ templateId: "gst-rate-mix", installs: 2 });
    expect(ranked[1]).toEqual({ templateId: "gst-recon-summary", installs: 1 });
    expect(ranked.every((r) => r.installs >= 0)).toBe(true);
  });

  it("handles an empty install log", () => {
    expect(rankByInstalls(entries, [])[0]!.installs).toBe(0);
  });

  it("badges only templates with real installs, up to the top N", () => {
    const installs = [
      { templateId: "gst-rate-mix", installs: 5 },
      { templateId: "gst-recon-summary", installs: 2 },
      { templateId: "tally-trial-balance", installs: 0 },
    ];
    const badges = mostInstalled(installs, 2);
    expect(badges.has("gst-rate-mix")).toBe(true);
    expect(badges.has("gst-recon-summary")).toBe(true);
    expect(badges.has("tally-trial-balance")).toBe(false);
  });
});
