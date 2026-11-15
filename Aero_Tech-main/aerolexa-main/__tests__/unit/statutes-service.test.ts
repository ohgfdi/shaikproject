/**
 * Statute & notification registry service — tests.
 *
 * These exercise the persistence decisions against the in-memory repository
 * (no database, no network): ingestion is idempotent, drafts never invent a
 * value, publishing CLOSES the window it replaces instead of deleting history
 * (so an as-on lookup for a past date still resolves what was in force then),
 * and a back-dated or same-day version is refused rather than silently
 * reordering the chain.
 */

import { ApiError } from "@/lib/auth/guard";
import { RULE_CATALOG } from "@/lib/engine/statutes";
import {
  canAuthorRegistry,
  draftVersionsFromNotification,
  extractFeedItems,
  ingestSource,
  memoryStatutesRepository,
  publishRuleVersion,
  registerSource,
  registryOverview,
  resolveRegistryRule,
  rulesInForceFor,
  seedBuiltInRuleVersions,
  type IngestDeps,
  type StatutesRepository,
} from "@/lib/server/statutes";

const WS = "ws-1";

async function fail(promise: Promise<unknown>): Promise<ApiError> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (err) {
    caught = err;
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(caught).toBeInstanceOf(ApiError);
  return caught as ApiError;
}

function feedPayload(items: unknown[]) {
  return { items };
}

function deps(items: unknown[]): IngestDeps {
  return { fetchFeed: async () => feedPayload(items) };
}

const SAMPLE_ITEMS = [
  {
    id: "12/2026",
    title: "Notification No. 12/2026 — TDS rate under section 194C",
    url: "https://www.incometax.gov.in/notifications/12-2026",
    publishedAt: "2026-03-30",
    summary: "With effect from 1 April 2026 the rate of deduction under section 194C is 2 per cent.",
  },
  {
    id: "13/2026",
    title: "Circular No. 13/2026 — clarification on cess",
    url: "https://www.incometax.gov.in/circulars/13-2026",
    summary: "The health and education cess continues at 4 per cent.",
  },
];

async function seededRepo() {
  const repo = memoryStatutesRepository();
  const source = await registerSource(repo, WS, "user-1", {
    key: "cbdt-notifications",
    name: "CBDT notifications",
    authority: "cbdt",
    url: "https://www.incometax.gov.in/notifications.json",
  });
  return { repo, source };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("canAuthorRegistry", () => {
  it("lets a solo workspace author its own registry", () => {
    expect(canAuthorRegistry({ organizationRole: null })).toBe(true);
  });

  it("lets firm partners, managers and administrators author it", () => {
    for (const role of ["OWNER", "ADMIN", "PARTNER", "MANAGER", "partner"]) {
      expect(canAuthorRegistry({ organizationRole: role })).toBe(true);
    }
  });

  it("lets everyone else read but not author", () => {
    for (const role of ["MEMBER", "AUDITOR", "VIEWER"]) {
      expect(canAuthorRegistry({ organizationRole: role })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe("registerSource", () => {
  it("normalises and stores a source", async () => {
    const { source } = await seededRepo();
    expect(source.key).toBe("cbdt-notifications");
    expect(source.authority).toBe("cbdt");
    expect(source.format).toBe("json");
    expect(source.active).toBe(true);
  });

  it("rejects a malformed key, an unknown authority, a blank name and a bad URL", async () => {
    const repo = memoryStatutesRepository();
    const base = { key: "cbdt-notifications", name: "CBDT", authority: "cbdt" as const, url: "https://x.test/f.json" };
    expect((await fail(registerSource(repo, WS, "u", { ...base, key: "Bad Key!" }))).code).toBe("STATUTES_INPUT");
    expect((await fail(registerSource(repo, WS, "u", { ...base, authority: "hmrc" as never }))).message).toMatch(
      /Unknown authority/,
    );
    expect((await fail(registerSource(repo, WS, "u", { ...base, name: "   " }))).message).toMatch(/name/i);
    expect((await fail(registerSource(repo, WS, "u", { ...base, url: "not-a-url" }))).message).toMatch(/https/i);
    expect((await fail(registerSource(repo, WS, "u", { ...base, url: "ftp://x.test/f" }))).message).toMatch(
      /http\(s\)/,
    );
  });

  it("refuses a duplicate source key in the same workspace", async () => {
    const { repo } = await seededRepo();
    const err = await fail(
      registerSource(repo, WS, "user-1", {
        key: "cbdt-notifications",
        name: "dupe",
        authority: "cbdt",
        url: "https://x.test/f.json",
      }),
    );
    expect(err.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

describe("extractFeedItems", () => {
  it("accepts a bare array and the common wrappers", () => {
    expect(extractFeedItems([{ title: "a" }])).toHaveLength(1);
    expect(extractFeedItems({ items: [{ title: "a" }] })).toHaveLength(1);
    expect(extractFeedItems({ notifications: [{ title: "a" }] })).toHaveLength(1);
    expect(extractFeedItems({ results: [{ title: "a" }] })).toHaveLength(1);
    expect(extractFeedItems({ nope: true })).toEqual([]);
    expect(extractFeedItems(null)).toEqual([]);
  });
});

describe("ingestSource", () => {
  it("stores every new item with provenance and marks the source checked", async () => {
    const { repo, source } = await seededRepo();
    const result = await ingestSource(repo, WS, source.id, deps(SAMPLE_ITEMS));

    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.notifications[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.notifications[0]!.impactedRuleKeys).toContain("tds-section-rate");
    expect(result.notifications[0]!.status).toBe("new");

    const reloaded = await repo.findSource(WS, source.id);
    expect(reloaded?.lastStatus).toBe("ok");
    expect(reloaded?.lastCheckedAt).toBeTruthy();
  });

  it("is idempotent — re-ingesting an unchanged feed inserts nothing", async () => {
    const { repo, source } = await seededRepo();
    await ingestSource(repo, WS, source.id, deps(SAMPLE_ITEMS));
    const second = await ingestSource(repo, WS, source.id, deps(SAMPLE_ITEMS));

    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(await repo.listNotifications(WS)).toHaveLength(2);
  });

  it("stores an edited item as a new notification (change detection)", async () => {
    const { repo, source } = await seededRepo();
    await ingestSource(repo, WS, source.id, deps(SAMPLE_ITEMS));
    const edited = [
      { ...SAMPLE_ITEMS[0]!, summary: "With effect from 1 April 2026 the rate is revised to 1.5 per cent." },
    ];
    const result = await ingestSource(repo, WS, source.id, deps(edited));
    expect(result.inserted).toBe(1);
    expect(await repo.listNotifications(WS)).toHaveLength(3);
  });

  it("skips items without a title and reports why", async () => {
    const { repo, source } = await seededRepo();
    const result = await ingestSource(repo, WS, source.id, deps([{ url: "https://x.test/1" }, ...SAMPLE_ITEMS]));
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(2);
    expect(result.warnings.join(" ")).toMatch(/Skipped/);
  });

  it("warns when the feed returns no items instead of pretending success", async () => {
    const { repo, source } = await seededRepo();
    const result = await ingestSource(repo, WS, source.id, deps([]));
    expect(result.inserted).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/no items/i);
  });

  it("records the fetch failure on the source and rethrows", async () => {
    const { repo, source } = await seededRepo();
    const boom: IngestDeps = {
      fetchFeed: async () => {
        throw new ApiError(502, "STATUTES_FETCH", "feed down");
      },
    };
    await fail(ingestSource(repo, WS, source.id, boom));
    const reloaded = await repo.findSource(WS, source.id);
    expect(reloaded?.lastStatus).toBe("error");
    expect(reloaded?.lastError).toBe("feed down");
  });

  it("refuses an inactive source and an unknown source", async () => {
    const { repo, source } = await seededRepo();
    await repo.updateSource(WS, source.id, { active: false });
    expect((await fail(ingestSource(repo, WS, source.id, deps([])))).message).toMatch(/disabled/i);
    expect((await fail(ingestSource(repo, WS, "nope", deps([])))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe("draftVersionsFromNotification", () => {
  it("proposes a draft carrying the in-force value AND the parsed effective date forward", async () => {
    const { repo, source } = await seededRepo();
    await seedBuiltInRuleVersions(repo, WS, "user-1");
    // The text says "With effect from 1 April 2026" — the draft must pick that up.
    const ingested = await ingestSource(repo, WS, source.id, deps([SAMPLE_ITEMS[0]!]));
    const notificationId = ingested.notifications[0]!.id;

    const drafts = await draftVersionsFromNotification(repo, WS, notificationId, { ruleKeys: ["cess"], ay: "2025-26" });
    expect(drafts).toHaveLength(1);
    const cess = drafts[0]!;
    expect(cess.ruleKey).toBe("cess");
    expect(cess.effectiveFrom).toBe("2026-04-01");
    // Carried forward from the seeded default so the reviewer edits one number.
    expect(cess.rows).toEqual([{ upTo: null, rate: 400 }]);
    expect(cess.valueSummary).toBe("Built-in baseline — Health & education cess");
    expect(cess.notificationId).toBe(notificationId);
    expect(cess.warnings).toEqual([]);
  });

  it("auto-matches the catalogue slot from the notification text when none is given", async () => {
    const { repo, source } = await seededRepo();
    const ingested = await ingestSource(repo, WS, source.id, deps([SAMPLE_ITEMS[0]!]));
    const drafts = await draftVersionsFromNotification(repo, WS, ingested.notifications[0]!.id, { ay: "2025-26" });
    expect(drafts.map((d) => d.ruleKey)).toContain("tds-section-rate");
  });

  it("flags a missing effective date rather than inventing one", async () => {
    const { repo, source } = await seededRepo();
    const ingested = await ingestSource(
      repo,
      WS,
      source.id,
      deps([{ title: "Circular on GST rate schedule", summary: "The GST rate bands are unchanged." }]),
    );
    const drafts = await draftVersionsFromNotification(repo, WS, ingested.notifications[0]!.id, { ay: "2026-27" });
    expect(drafts[0]!.effectiveFrom).toBeNull();
    expect(drafts[0]!.warnings.join(" ")).toMatch(/effective date/i);
    expect(drafts[0]!.warnings.join(" ")).toMatch(/Nothing is currently in force/i);
    expect(drafts[0]!.rows).toEqual([]); // never inventoried from thin air
  });

  it("refuses when no slot matched (the reviewer must choose)", async () => {
    const { repo, source } = await seededRepo();
    const ingested = await ingestSource(
      repo,
      WS,
      source.id,
      deps([{ title: "Office holiday list", summary: "Closed on Friday." }]),
    );
    const err = await fail(draftVersionsFromNotification(repo, WS, ingested.notifications[0]!.id, { ay: "2026-27" }));
    expect(err.message).toMatch(/matched no rule slot/i);
  });

  it("accepts an explicit rule key override and rejects an unknown one", async () => {
    const { repo, source } = await seededRepo();
    const ingested = await ingestSource(repo, WS, source.id, deps([{ title: "Office holiday list" }]));
    const id = ingested.notifications[0]!.id;
    const drafts = await draftVersionsFromNotification(repo, WS, id, { ruleKeys: ["cess"], ay: "2026-27" });
    expect(drafts.map((d) => d.ruleKey)).toEqual(["cess"]);
    expect((await fail(draftVersionsFromNotification(repo, WS, id, { ruleKeys: ["nope"] }))).message).toMatch(
      /not a rule/,
    );
  });

  it("404s for an unknown notification", async () => {
    const repo = memoryStatutesRepository();
    expect((await fail(draftVersionsFromNotification(repo, WS, "missing"))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Publishing + supersession
// ---------------------------------------------------------------------------

function cessInput(effectiveFrom: string, rate = 400) {
  return {
    ruleKey: "cess",
    applicability: { ay: "2025-26", entityTypes: [], states: [], scope: "central" as const },
    unit: "bps" as const,
    rows: [{ upTo: null, rate }],
    valueSummary: `Cess ${rate / 100}%`,
    citation: "Finance Act 2025",
    effectiveFrom,
    effectiveTo: null,
    publishedById: "user-1",
  };
}

describe("publishRuleVersion", () => {
  it("publishes the first version as open-ended", async () => {
    const repo = memoryStatutesRepository();
    const { version } = await publishRuleVersion(repo, WS, cessInput("2025-04-01"));
    expect(version.version).toBe(1);
    expect(version.status).toBe("published");
    expect(version.effectiveTo).toBeNull();
    expect(version.publishedAt).toBeTruthy();
    expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CLOSES the replaced window instead of deleting history", async () => {
    const repo = memoryStatutesRepository();
    const first = await publishRuleVersion(repo, WS, cessInput("2025-04-01", 400));
    const second = await publishRuleVersion(repo, WS, cessInput("2026-04-01", 500));

    expect(second.version.version).toBe(2);
    expect(second.version.supersedes).toBe(first.version.id);
    expect(second.closed.map((v) => v.id)).toEqual([first.version.id]);

    const all = await repo.listRuleVersions(WS, "cess");
    const old = all.find((v) => v.version === 1)!;
    expect(old.status).toBe("published"); // still resolvable for past dates
    expect(old.effectiveTo).toBe("2026-04-01");

    // The historical date still resolves what was genuinely in force then.
    expect(
      (await resolveRegistryRule(repo, WS, { ruleKey: "cess", asOn: "2025-06-01", ay: "2025-26" }))?.version.version,
    ).toBe(1);
    expect(
      (await resolveRegistryRule(repo, WS, { ruleKey: "cess", asOn: "2026-05-01", ay: "2025-26" }))?.version.version,
    ).toBe(2);
  });

  it("refuses a version starting on the same date as an existing one", async () => {
    const repo = memoryStatutesRepository();
    await publishRuleVersion(repo, WS, cessInput("2025-04-01"));
    const err = await fail(publishRuleVersion(repo, WS, cessInput("2025-04-01", 500)));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/already starts on/);
  });

  it("refuses a back-dated version (the chain is monotonic)", async () => {
    const repo = memoryStatutesRepository();
    await publishRuleVersion(repo, WS, cessInput("2026-04-01"));
    const err = await fail(publishRuleVersion(repo, WS, cessInput("2025-04-01", 500)));
    expect(err.message).toMatch(/must start on a later date/);
  });

  it("validates the draft and rejects an unknown slot", async () => {
    const repo = memoryStatutesRepository();
    expect((await fail(publishRuleVersion(repo, WS, { ...cessInput("2025-04-01"), ruleKey: "nope" }))).message).toMatch(
      /Unknown rule/,
    );
    expect((await fail(publishRuleVersion(repo, WS, { ...cessInput("bad-date") }))).message).toMatch(/yyyy-mm-dd/);
  });

  it("scopes the chain by applicability — a state rule may start alongside an all-India rule", async () => {
    const repo = memoryStatutesRepository();
    await publishRuleVersion(repo, WS, {
      ...cessInput("2025-04-01"),
      ruleKey: "professional-tax-slab",
      applicability: { ay: null, entityTypes: [], states: [], scope: "central" },
      rows: [{ upTo: null, rate: 200 }],
    });
    const mh = await publishRuleVersion(repo, WS, {
      ...cessInput("2025-04-01"),
      ruleKey: "professional-tax-slab",
      applicability: { ay: null, entityTypes: [], states: ["MH"], scope: "state" },
      rows: [{ upTo: null, rate: 250 }],
    });
    // Version numbers are per rule key across scopes, but the two chains are
    // independent — publishing the state rule must not close the central one.
    expect(mh.version.version).toBe(2);
    expect(mh.closed).toEqual([]);
    const resolved = await resolveRegistryRule(repo, WS, {
      ruleKey: "professional-tax-slab",
      asOn: "2025-06-01",
      state: "MH",
    });
    expect(resolved?.version.applicability.states).toEqual(["MH"]);
  });

  it("marks the source notification applied when a version cites it", async () => {
    const { repo, source } = await seededRepo();
    const ingested = await ingestSource(repo, WS, source.id, deps([SAMPLE_ITEMS[1]!]));
    const notificationId = ingested.notifications[0]!.id;
    await publishRuleVersion(repo, WS, { ...cessInput("2025-04-01"), notificationId });
    const after = await repo.findNotification(WS, notificationId);
    expect(after?.status).toBe("applied");
  });
});

// ---------------------------------------------------------------------------
// Desk views
// ---------------------------------------------------------------------------

describe("registryOverview and seedBuiltInRuleVersions", () => {
  it("materialises the built-in defaults once and skips them afterwards", async () => {
    const repo = memoryStatutesRepository();
    const first = await seedBuiltInRuleVersions(repo, WS, "user-1");
    expect(first.published).toBeGreaterThan(3);
    expect(first.skipped).toBe(0);
    const second = await seedBuiltInRuleVersions(repo, WS, "user-1");
    expect(second.published).toBe(0);
    expect(second.skipped).toBe(first.published);
  });

  it("summarises what is in force and what a reviewer still has to supply", async () => {
    const repo = memoryStatutesRepository();
    await seedBuiltInRuleVersions(repo, WS, "user-1");
    const overview = await registryOverview(repo, WS, { asOn: "2025-06-15", ay: "2025-26" });

    expect(overview.entries).toHaveLength(RULE_CATALOG.length); // the whole catalogue
    expect(overview.summary.rulesInForce).toBeGreaterThan(0);
    // Due-date windows have no built-in default — they must NOT resolve.
    const roc = overview.entries.find((e) => e.key === "roc-aoc4-due-days")!;
    expect(roc.unresolved).toBe(true);
    expect(roc.inForce).toBeNull();
    const cess = overview.entries.find((e) => e.key === "cess")!;
    expect(cess.unresolved).toBe(false);
    expect(cess.inForce?.rows).toEqual([{ upTo: null, rate: 400 }]);
  });

  it("lists everything in force for an as-on date", async () => {
    const repo = memoryStatutesRepository();
    await seedBuiltInRuleVersions(repo, WS, "user-1");
    const inForce = await rulesInForceFor(repo, WS, "2025-06-15", { ay: "2025-26" });
    expect(inForce.map((v) => v.ruleKey)).toContain("cess");
    expect(inForce.every((v) => v.status === "published")).toBe(true);
  });

  it("reports an empty registry honestly instead of inventing rules", async () => {
    const repo: StatutesRepository = memoryStatutesRepository();
    const overview = await registryOverview(repo, WS, { asOn: "2025-06-15", ay: "2025-26" });
    expect(overview.summary.rulesInForce).toBe(0);
    expect(overview.summary.rulesUnresolved).toBe(overview.entries.length);
    expect(overview.sources).toEqual([]);
    expect(overview.notifications).toEqual([]);
  });
});
