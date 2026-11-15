/**
 * Statute & notification registry service — the persistence + ingestion layer
 * around the pure engine in lib/engine/statutes.ts.
 *
 * TWO PATHS, ONE MODEL
 *   Ingestion: a source (an authority feed) is fetched, each item is normalised
 *              and stored as a StatuteNotification, deduped by content hash.
 *              Nothing is published — an item is evidence, not a rule.
 *   Registry:  a reviewer turns an item into DRAFT rule versions, edits them
 *              against the actual notification, and publishes. Publishing an
 *              already-open version CLOSES its window (effectiveTo = the new
 *              version's effectiveFrom) instead of deleting history, so an
 *              as-on lookup for a past date still resolves the rule that was
 *              genuinely in force then. That is what makes a filed number
 *              reproducible years later.
 *
 * WHY A REPOSITORY INTERFACE
 * The rules above are pure decisions (what supersedes what, what was in force
 * when). Expressing them against a narrow `StatutesRepository` keeps them
 * unit-testable with an in-memory store AND lets the app run them against
 * Prisma — the same code, no test-only branches.
 */

import { ApiError } from "@/lib/auth/guard";
import { getRateTable } from "@/lib/engine/ca-rate-registry";
import {
  RULE_CATALOG,
  StatutesError,
  hashRuleVersion,
  normalizeNotification,
  resolveRuleVersion,
  ruleDefinition,
  rulesInForce as rulesInForceEngine,
  validateRuleVersionInput,
  type Applicability,
  type NotificationAuthority,
  type NotificationKind,
  type ParsedNotification,
  type Resolution,
  type RuleRow,
  type RuleUnit,
  type RuleVersionInput,
  type RuleVersionRecord,
} from "@/lib/engine/statutes";
import { assertSafeExternalUrl, safeExternalFetch } from "@/lib/server/url-guard";

// ---------------------------------------------------------------------------
// Views (what the API/UI consumes)
// ---------------------------------------------------------------------------

export interface StatuteSourceView {
  id: string;
  key: string;
  name: string;
  authority: NotificationAuthority;
  url: string;
  format: string;
  kind: string;
  active: boolean;
  checkCron: string | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

export interface NotificationView {
  id: string;
  sourceId: string;
  sourceKey: string | null;
  externalId: string | null;
  title: string;
  url: string;
  authority: NotificationAuthority;
  kind: NotificationKind;
  publishedAt: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  excerpt: string;
  contentHash: string;
  impactedRuleKeys: string[];
  warnings: string[];
  status: string;
  fetchedAt: string;
}

export interface RuleRegistryEntry {
  key: string;
  label: string;
  unit: RuleUnit;
  authority: NotificationAuthority;
  description: string;
  cadence: "annual" | "quarterly" | "ad-hoc";
  /** The version in force on the requested as-on date, or null. */
  inForce: RuleVersionRecord | null;
  /** Newest version of any status (draft or published). */
  latest: RuleVersionRecord | null;
  versions: number;
  /** True when nothing is in force — the caller must not guess a value. */
  unresolved: boolean;
}

export interface RegistryOverview {
  asOn: string;
  context: { ay: string | null; entityType: string | null; state: string | null };
  entries: RuleRegistryEntry[];
  notifications: NotificationView[];
  sources: StatuteSourceView[];
  /** Counters that make "is the firm current?" answerable at a glance. */
  summary: {
    rulesTracked: number;
    rulesInForce: number;
    rulesUnresolved: number;
    notificationsNew: number;
    sourcesActive: number;
  };
}

export interface IngestResult {
  sourceId: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  notifications: NotificationView[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

export interface StatuteSourceInput {
  key: string;
  name: string;
  authority: NotificationAuthority;
  url: string;
  format?: string;
  kind?: string;
  active?: boolean;
  checkCron?: string | null;
}

export interface PublisherInput extends RuleVersionInput {
  /** The reviewer publishing this version (audit trail). */
  publishedById: string;
  notes?: string | null;
}

export interface StatutesRepository {
  listSources(workspaceId: string): Promise<StatuteSourceView[]>;
  findSource(workspaceId: string, id: string): Promise<StatuteSourceView | null>;
  findSourceByKey(workspaceId: string, key: string): Promise<StatuteSourceView | null>;
  createSource(workspaceId: string, createdById: string, input: StatuteSourceInput): Promise<StatuteSourceView>;
  updateSource(workspaceId: string, id: string, patch: Partial<StatuteSourceView>): Promise<StatuteSourceView>;
  listNotifications(workspaceId: string, opts?: { status?: string; limit?: number }): Promise<NotificationView[]>;
  findNotification(workspaceId: string, id: string): Promise<NotificationView | null>;
  /** Insert unless an identical content hash already exists (idempotent ingest). */
  insertNotification(
    workspaceId: string,
    sourceId: string,
    parsed: ParsedNotification,
  ): Promise<{ inserted: boolean; notification: NotificationView }>;
  setNotificationStatus(workspaceId: string, id: string, status: string, appliedAt: string | null): Promise<void>;
  listRuleVersions(workspaceId: string, ruleKey?: string): Promise<RuleVersionRecord[]>;
  createRuleVersion(
    workspaceId: string,
    input: RuleVersionInput & {
      version: number;
      status: "draft" | "published";
      contentHash: string;
      supersedesId: string | null;
      publishedById: string | null;
      notes: string | null;
    },
  ): Promise<RuleVersionRecord>;
  updateRuleVersion(
    workspaceId: string,
    id: string,
    patch: { status?: string; effectiveTo?: string | null; supersededBy?: never },
  ): Promise<RuleVersionRecord>;
}

/**
 * Who may AUTHOR the registry (add sources, ingest, publish a rule version).
 * Reading what is in force never needs this — only changing it does, because a
 * published version is the number every future filing will be computed from.
 *
 * A workspace with no organization is a solo practitioner: the signed-in user
 * owns it. Once a firm organization exists, firm practitioners (OWNER / ADMIN /
 * PARTNER / MANAGER) author the registry and others may read it.
 */
export const REGISTRY_AUTHOR_ROLES = ["OWNER", "ADMIN", "PARTNER", "MANAGER"] as const;

export function canAuthorRegistry(ctx: { organizationRole: string | null }): boolean {
  if (!ctx.organizationRole) return true;
  return (REGISTRY_AUTHOR_ROLES as readonly string[]).includes(ctx.organizationRole.toUpperCase());
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

const AUTHORITIES: readonly NotificationAuthority[] = [
  "cbdt",
  "cbic",
  "mca",
  "rbi",
  "epfo",
  "gst-council",
  "state",
  "other",
];

function asApiError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof StatutesError) throw new ApiError(400, "STATUTES_INPUT", err.message);
  throw err;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseRows(value: string): RuleRow[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is { upTo: number | null; rate: number; label?: string } => r !== null && typeof r === "object")
      .map((r) => ({ upTo: r.upTo ?? null, rate: r.rate, label: r.label }));
  } catch {
    return [];
  }
}

const sameApplicability = (a: Applicability, b: Applicability): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Pure service logic (works against any repository)
// ---------------------------------------------------------------------------

/**
 * Register an ingestion source. The authority is explicit (never guessed from
 * free text) so the audit trail names a real publisher.
 */
export async function registerSource(
  repo: StatutesRepository,
  workspaceId: string,
  createdById: string,
  input: StatuteSourceInput,
): Promise<StatuteSourceView> {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(key)) {
    throw new ApiError(
      400,
      "STATUTES_INPUT",
      'Source key must be lowercase letters, digits and dashes (e.g. "cbdt-notifications").',
    );
  }
  if (!AUTHORITIES.includes(input.authority)) {
    throw new ApiError(400, "STATUTES_INPUT", `Unknown authority "${input.authority}".`);
  }
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "STATUTES_INPUT", "Give the source a name.");
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new ApiError(400, "STATUTES_INPUT", "Enter the feed/document URL, including https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "STATUTES_INPUT", "Only http(s) URLs are supported.");
  }
  const existing = await repo.findSourceByKey(workspaceId, key);
  if (existing) throw new ApiError(409, "STATUTES_SOURCE_EXISTS", `A source with key "${key}" already exists.`);
  return repo.createSource(workspaceId, createdById, {
    key,
    name,
    authority: input.authority,
    url: url.toString(),
    format: input.format,
    kind: input.kind,
    active: input.active,
    checkCron: input.checkCron ?? null,
  });
}

/** Default feed fetcher: SSRF-guarded GET + JSON parse. */
async function defaultFetchFeed(url: string): Promise<unknown> {
  let res: Response;
  try {
    await assertSafeExternalUrl(url);
    res = await safeExternalFetch(url, { headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" } });
  } catch (err) {
    throw new ApiError(502, "STATUTES_FETCH", err instanceof Error ? err.message : "Could not reach the feed.");
  }
  if (!res.ok) {
    throw new ApiError(502, "STATUTES_FETCH", `The feed answered HTTP ${res.status}. Check the URL and any token.`);
  }
  const body = await res.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(502, "STATUTES_FETCH", "The feed body is not valid JSON. Point the source at a JSON feed.");
  }
}

export interface IngestDeps {
  /** Injectable feed fetcher (tests never touch the network). */
  fetchFeed?: (url: string) => Promise<unknown>;
}

interface FeedItem {
  id?: string;
  externalId?: string;
  title?: string;
  name?: string;
  url?: string;
  link?: string;
  publishedAt?: string;
  published?: string;
  date?: string;
  summary?: string;
  text?: string;
  description?: string;
  body?: string;
}

/** Accept a bare array, or a {items|notifications|data|results} wrapper. */
export function extractFeedItems(payload: unknown): FeedItem[] {
  const array = Array.isArray(payload)
    ? payload
    : ((payload as Record<string, unknown> | null)?.items ??
      (payload as Record<string, unknown> | null)?.notifications ??
      (payload as Record<string, unknown> | null)?.data ??
      (payload as Record<string, unknown> | null)?.results);
  if (!Array.isArray(array)) return [];
  return array.filter((x): x is FeedItem => x !== null && typeof x === "object" && !Array.isArray(x));
}

/**
 * Fetch a source and store every new item. Idempotent: re-running against an
 * unchanged feed inserts nothing (the content hash already exists). Items
 * without a title are skipped and counted, never silently dropped.
 */
export async function ingestSource(
  repo: StatutesRepository,
  workspaceId: string,
  sourceId: string,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const source = await repo.findSource(workspaceId, sourceId);
  if (!source) throw new ApiError(404, "STATUTES_NOT_FOUND", "Ingestion source not found.");
  if (!source.active) throw new ApiError(400, "STATUTES_INPUT", "This source is disabled. Enable it before ingesting.");

  const fetchFeed = deps.fetchFeed ?? defaultFetchFeed;
  const warnings: string[] = [];
  let payload: unknown;
  try {
    payload = await fetchFeed(source.url);
  } catch (err) {
    await repo.updateSource(workspaceId, source.id, {
      lastCheckedAt: new Date().toISOString(),
      lastStatus: "error",
      lastError: err instanceof Error ? err.message : "Feed fetch failed.",
    });
    throw err;
  }

  const items = extractFeedItems(payload);
  if (items.length === 0) {
    warnings.push("The feed returned no items — check that the URL points at a JSON feed and not an HTML page.");
  }

  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;
  const notifications: NotificationView[] = [];

  for (const item of items) {
    const title = (item.title ?? item.name ?? "").trim();
    if (!title) {
      skipped += 1;
      warnings.push(
        `Skipped an item with no title (externalId ${item.externalId ?? item.id ?? "none"}) — a notification needs a title.`,
      );
      continue;
    }
    let parsed: ParsedNotification;
    try {
      parsed = normalizeNotification({
        sourceKey: source.key,
        externalId: item.externalId ?? item.id ?? null,
        title,
        url: item.url ?? item.link ?? source.url,
        publishedAt: item.publishedAt ?? item.published ?? item.date ?? null,
        bodyText: item.summary ?? item.text ?? item.description ?? item.body ?? null,
        authority: source.authority,
      });
    } catch (err) {
      skipped += 1;
      warnings.push(`Skipped "${title.slice(0, 60)}": ${err instanceof Error ? err.message : "normalisation failed"}`);
      continue;
    }
    const { inserted: isNew, notification } = await repo.insertNotification(workspaceId, source.id, parsed);
    if (isNew) {
      inserted += 1;
      notifications.push(notification);
    } else {
      duplicates += 1;
    }
  }

  await repo.updateSource(workspaceId, source.id, {
    lastCheckedAt: new Date().toISOString(),
    lastStatus: skipped > 0 && inserted === 0 ? "partial" : "ok",
    lastError: null,
  });

  return { sourceId: source.id, fetched: items.length, inserted, duplicates, skipped, notifications, warnings };
}

export interface RuleVersionDraft {
  ruleKey: string;
  label: string;
  unit: RuleUnit;
  applicability: Applicability;
  /** Rows carried over from the version currently in force (edit before publishing). */
  rows: RuleRow[];
  valueSummary: string;
  citation: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  notificationId: string;
  warnings: string[];
}

/**
 * Turn an ingested notification into DRAFT versions. The draft never invents a
 * value: it carries the current in-force rows forward so the reviewer changes
 * the one number the notification changed. Missing effective dates remain null
 * and are flagged — publishing requires a date.
 */
export async function draftVersionsFromNotification(
  repo: StatutesRepository,
  workspaceId: string,
  notificationId: string,
  opts: { ruleKeys?: string[]; ay?: string | null } = {},
): Promise<RuleVersionDraft[]> {
  const notification = await repo.findNotification(workspaceId, notificationId);
  if (!notification) throw new ApiError(404, "STATUTES_NOT_FOUND", "Notification not found.");

  const keys = (opts.ruleKeys && opts.ruleKeys.length > 0 ? opts.ruleKeys : notification.impactedRuleKeys).filter(
    Boolean,
  );
  if (keys.length === 0) {
    throw new ApiError(
      400,
      "STATUTES_INPUT",
      "The parser matched no rule slot for this notification. Choose the rule(s) it changes and try again.",
    );
  }
  const versions = await repo.listRuleVersions(workspaceId);
  const asOn = notification.effectiveFrom ?? new Date().toISOString().slice(0, 10);

  const drafts: RuleVersionDraft[] = [];
  for (const key of keys) {
    let def;
    try {
      def = ruleDefinition(key);
    } catch {
      throw new ApiError(400, "STATUTES_INPUT", `"${key}" is not a rule in the catalogue.`);
    }
    const resolution = resolveRuleVersion(versions, { ruleKey: key, asOn, ay: opts.ay ?? null });
    const warnings: string[] = [];
    if (!notification.effectiveFrom) warnings.push("No effective date in the notification — set it before publishing.");
    if (!resolution)
      warnings.push("Nothing is currently in force for this rule on that date — enter the values manually.");
    drafts.push({
      ruleKey: key,
      label: def.label,
      unit: def.unit,
      applicability: resolution?.version.applicability ?? {
        ay: opts.ay ?? null,
        entityTypes: [],
        states: [],
        scope: "central",
      },
      rows: resolution?.version.rows ?? [],
      valueSummary: resolution?.version.valueSummary ?? "",
      citation: notification.externalId
        ? `${notification.authority.toUpperCase()} ${notification.externalId}`
        : notification.title,
      effectiveFrom: notification.effectiveFrom,
      effectiveTo: notification.effectiveTo,
      notificationId: notification.id,
      warnings,
    });
  }
  return drafts;
}

/**
 * Publish a rule version.
 *
 * The chain is monotonic per (rule key + applicability):
 *   - a version may only start on a date strictly AFTER the latest start;
 *   - identical content is rejected as a duplicate;
 *   - an open version whose window covers the new start is CLOSED
 *     (effectiveTo = new effectiveFrom) rather than deleted, so historical
 *     as-on lookups still resolve what was genuinely in force.
 */
export async function publishRuleVersion(
  repo: StatutesRepository,
  workspaceId: string,
  input: PublisherInput,
): Promise<{ version: RuleVersionRecord; closed: RuleVersionRecord[] }> {
  try {
    validateRuleVersionInput(input);
  } catch (err) {
    asApiError(err);
  }

  const versions = await repo.listRuleVersions(workspaceId, input.ruleKey);
  const sameScope = versions.filter(
    (v) => v.status === "published" && sameApplicability(v.applicability, input.applicability),
  );

  const effectiveTo = input.effectiveTo ?? null;
  for (const v of sameScope) {
    if (input.effectiveFrom < v.effectiveFrom) {
      throw new ApiError(
        409,
        "STATUTES_CONFLICT",
        `A version already starts on ${v.effectiveFrom} (v${v.version}). A new version must start on a later date — correct the existing version instead of back-dating one.`,
      );
    }
    if (input.effectiveFrom === v.effectiveFrom) {
      throw new ApiError(
        409,
        "STATUTES_CONFLICT",
        `v${v.version} already starts on ${v.effectiveFrom}. Edit it or choose a later effective date.`,
      );
    }
  }

  const contentHash = hashRuleVersion({
    ruleKey: input.ruleKey,
    applicability: input.applicability,
    unit: input.unit,
    rows: input.rows,
    citation: input.citation,
    effectiveFrom: input.effectiveFrom,
    effectiveTo,
    valueSummary: input.valueSummary,
  });
  if (versions.some((v) => v.contentHash === contentHash)) {
    throw new ApiError(409, "STATUTES_CONFLICT", "An identical version already exists for this rule and window.");
  }

  // Close the open window(s) this version replaces — history is preserved.
  const toClose = sameScope.filter((v) => v.effectiveTo === null || v.effectiveTo > input.effectiveFrom);
  const closed: RuleVersionRecord[] = [];
  for (const v of toClose) {
    if (v.effectiveTo !== null && v.effectiveTo <= input.effectiveFrom) continue;
    closed.push(await repo.updateRuleVersion(workspaceId, v.id, { effectiveTo: input.effectiveFrom }));
  }

  const latestVersionNumber = versions.reduce((max, v) => Math.max(max, v.version), 0);
  const supersedes = toClose.length > 0 ? [...toClose].sort((a, b) => b.version - a.version)[0]!.id : null;

  const created = await repo.createRuleVersion(workspaceId, {
    ruleKey: input.ruleKey,
    applicability: input.applicability,
    unit: input.unit,
    rows: input.rows,
    valueSummary: input.valueSummary,
    citation: input.citation,
    effectiveFrom: input.effectiveFrom,
    effectiveTo,
    notificationId: input.notificationId ?? null,
    version: latestVersionNumber + 1,
    status: "published",
    contentHash,
    supersedesId: supersedes,
    publishedById: input.publishedById,
    notes: input.notes ?? null,
  });

  if (input.notificationId) {
    await repo.setNotificationStatus(workspaceId, input.notificationId, "applied", new Date().toISOString());
  }
  return { version: created, closed };
}

/** Resolve the rule in force for a query (delegates to the pure engine). */
export async function resolveRegistryRule(
  repo: StatutesRepository,
  workspaceId: string,
  query: { ruleKey: string; asOn: string; ay?: string | null; entityType?: string | null; state?: string | null },
): Promise<Resolution | null> {
  const versions = await repo.listRuleVersions(workspaceId, query.ruleKey);
  try {
    return resolveRuleVersion(versions, query);
  } catch (err) {
    asApiError(err);
  }
}

/** Everything in force on a date, for the audit/desk view. */
export async function rulesInForceFor(
  repo: StatutesRepository,
  workspaceId: string,
  asOn: string,
  query: { ay?: string | null; entityType?: string | null; state?: string | null } = {},
): Promise<RuleVersionRecord[]> {
  const versions = await repo.listRuleVersions(workspaceId);
  return rulesInForceEngine(versions, asOn, query);
}

/** The registry desk view: catalogue + what is in force + what needs review. */
export async function registryOverview(
  repo: StatutesRepository,
  workspaceId: string,
  opts: { asOn?: string; ay?: string | null; entityType?: string | null; state?: string | null } = {},
): Promise<RegistryOverview> {
  const asOn = opts.asOn ?? new Date().toISOString().slice(0, 10);
  const context = { ay: opts.ay ?? null, entityType: opts.entityType ?? null, state: opts.state ?? null };
  const [sources, notifications, versions] = await Promise.all([
    repo.listSources(workspaceId),
    repo.listNotifications(workspaceId, { limit: 25 }),
    repo.listRuleVersions(workspaceId),
  ]);

  const entries: RuleRegistryEntry[] = RULE_CATALOG.map((def) => {
    const forRule = versions.filter((v) => v.ruleKey === def.key);
    const resolution = resolveRuleVersion(forRule, { ruleKey: def.key, asOn, ...context });
    const latest =
      [...forRule].sort((a, b) =>
        a.effectiveFrom === b.effectiveFrom ? b.version - a.version : a.effectiveFrom < b.effectiveFrom ? 1 : -1,
      )[0] ?? null;
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      authority: def.authority,
      description: def.description,
      cadence: def.cadence,
      inForce: resolution?.version ?? null,
      latest,
      versions: forRule.length,
      unresolved: !resolution,
    };
  });

  return {
    asOn,
    context,
    entries,
    notifications,
    sources,
    summary: {
      rulesTracked: entries.length,
      rulesInForce: entries.filter((e) => !e.unresolved).length,
      rulesUnresolved: entries.filter((e) => e.unresolved).length,
      notificationsNew: notifications.filter((n) => n.status === "new").length,
      sourcesActive: sources.filter((s) => s.active).length,
    },
  };
}

/**
 * Materialise the built-in Finance Act defaults (AY 2025-26) as PUBLISHED rule
 * versions, so the starting point of every rule is visible and dated rather
 * than living only in code. Idempotent — an identical version is skipped.
 */
export async function seedBuiltInRuleVersions(
  repo: StatutesRepository,
  workspaceId: string,
  publishedById: string,
): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;
  for (const def of RULE_CATALOG) {
    if (!def.rateKind) continue;
    let table;
    try {
      table = getRateTable("2025-26", def.rateKind).table;
    } catch {
      continue; // no built-in default for this slot — the reviewer supplies it
    }
    // A slab chain has at most one open-ended row, and only as the last row.
    // The corporate-rate default is two ALTERNATIVE regimes rather than a chain,
    // so it cannot be stored as a slab version — skip it (the reviewer enters
    // the chosen regime explicitly) instead of writing an invalid rule.
    if (table.rows.filter((r) => r.upTo === null).length > 1) continue;
    const rows: RuleRow[] = table.rows.map((r) => ({ upTo: r.upTo, rate: r.rate }));
    try {
      await publishRuleVersion(repo, workspaceId, {
        ruleKey: def.key,
        applicability: { ay: "2025-26", entityTypes: [], states: [], scope: "central" },
        unit: table.unit,
        rows,
        valueSummary: `Built-in baseline — ${def.label}`,
        citation: table.source,
        effectiveFrom: table.asOn,
        effectiveTo: null,
        publishedById,
        notes: `Materialised from the engine default (${table.ay}) so the registry has a dated starting point.`,
      });
      published += 1;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  return { published, skipped };
}

// ---------------------------------------------------------------------------
// In-memory repository (tests + local demos)
// ---------------------------------------------------------------------------

type MemorySourceRow = StatuteSourceView & { workspaceId: string; createdById: string };
type MemoryNotificationRow = NotificationView & { workspaceId: string };
type MemoryVersionRow = RuleVersionRecord & { workspaceId: string };

export function memoryStatutesRepository(): StatutesRepository {
  const sources = new Map<string, MemorySourceRow>();
  const notifications = new Map<string, MemoryNotificationRow>();
  const versions = new Map<string, MemoryVersionRow>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  return {
    async listSources(workspaceId) {
      return [...sources.values()].filter((s) => s.workspaceId === workspaceId).map((s) => ({ ...s }));
    },
    async findSource(workspaceId, id) {
      const row = sources.get(id);
      return row && row.workspaceId === workspaceId ? { ...row } : null;
    },
    async findSourceByKey(workspaceId, key) {
      const row = [...sources.values()].find((s) => s.workspaceId === workspaceId && s.key === key);
      return row ? { ...row } : null;
    },
    async createSource(workspaceId, createdById, input) {
      const id = nextId("src");
      const row: MemorySourceRow = {
        id,
        workspaceId,
        createdById,
        key: input.key,
        name: input.name,
        authority: input.authority,
        url: input.url,
        format: input.format ?? "json",
        kind: input.kind ?? "notification",
        active: input.active ?? true,
        checkCron: input.checkCron ?? null,
        lastCheckedAt: null,
        lastStatus: null,
        lastError: null,
      };
      sources.set(id, row);
      return { ...row };
    },
    async updateSource(workspaceId, id, patch) {
      const row = sources.get(id);
      if (!row || row.workspaceId !== workspaceId) throw new ApiError(404, "STATUTES_NOT_FOUND", "Source not found.");
      Object.assign(row, patch);
      return { ...row };
    },
    async listNotifications(workspaceId, opts) {
      return [...notifications.values()]
        .filter((n) => n.workspaceId === workspaceId && (!opts?.status || n.status === opts.status))
        .sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1))
        .slice(0, opts?.limit ?? 100)
        .map((n) => ({ ...n }));
    },
    async findNotification(workspaceId, id) {
      const row = notifications.get(id);
      return row && row.workspaceId === workspaceId ? { ...row } : null;
    },
    async insertNotification(workspaceId, sourceId, parsed) {
      const existing = [...notifications.values()].find(
        (n) => n.workspaceId === workspaceId && n.sourceId === sourceId && n.contentHash === parsed.contentHash,
      );
      if (existing) return { inserted: false, notification: { ...existing } };
      const id = nextId("note");
      const row: MemoryNotificationRow = {
        id,
        workspaceId,
        sourceId,
        sourceKey: parsed.sourceKey,
        externalId: parsed.externalId,
        title: parsed.title,
        url: parsed.url,
        authority: parsed.authority,
        kind: parsed.kind,
        publishedAt: parsed.publishedAt,
        effectiveFrom: parsed.effectiveFrom,
        effectiveTo: parsed.effectiveTo,
        excerpt: parsed.excerpt,
        contentHash: parsed.contentHash,
        impactedRuleKeys: parsed.impactedRuleKeys,
        warnings: parsed.warnings,
        status: "new",
        fetchedAt: new Date().toISOString(),
      };
      notifications.set(id, row);
      return { inserted: true, notification: { ...row } };
    },
    async setNotificationStatus(workspaceId, id, status, appliedAt) {
      const row = notifications.get(id);
      if (!row || row.workspaceId !== workspaceId) return;
      row.status = status;
      void appliedAt;
    },
    async listRuleVersions(workspaceId, ruleKey) {
      return [...versions.values()]
        .filter((v) => v.workspaceId === workspaceId && (!ruleKey || v.ruleKey === ruleKey))
        .map((v) => ({ ...v }));
    },
    async createRuleVersion(workspaceId, input) {
      const id = nextId("ver");
      const row: MemoryVersionRow = {
        id,
        workspaceId,
        ruleKey: input.ruleKey,
        version: input.version,
        applicability: input.applicability,
        unit: input.unit,
        rows: input.rows,
        valueSummary: input.valueSummary,
        citation: input.citation,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        status: input.status,
        notificationId: input.notificationId ?? null,
        supersedes: input.supersedesId,
        contentHash: input.contentHash,
        createdAt: new Date().toISOString(),
        publishedAt: input.status === "published" ? new Date().toISOString() : null,
        publishedBy: input.publishedById,
        notes: input.notes,
      };
      versions.set(id, row);
      return { ...row };
    },
    async updateRuleVersion(workspaceId, id, patch) {
      const row = versions.get(id);
      if (!row || row.workspaceId !== workspaceId)
        throw new ApiError(404, "STATUTES_NOT_FOUND", "Rule version not found.");
      if (patch.status !== undefined) row.status = patch.status as RuleVersionRecord["status"];
      if (patch.effectiveTo !== undefined) row.effectiveTo = patch.effectiveTo;
      return { ...row };
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma repository (production)
// ---------------------------------------------------------------------------

/**
 * Prisma-backed repository. JSON columns (rows / entityTypes / states /
 * impactedRuleKeys / warnings) are stored as text because SQLite has no array
 * or JSON type — the same pattern the rest of the schema uses (see
 * Workspace.settings, Connector.config).
 */
export async function prismaStatutesRepository(): Promise<StatutesRepository> {
  const { prisma } = await import("@/lib/db");
  type SourceRow = {
    id: string;
    key: string;
    name: string;
    authority: string;
    url: string;
    format: string;
    kind: string;
    active: boolean;
    checkCron: string | null;
    lastCheckedAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
  };
  type NoteRow = {
    id: string;
    sourceId: string;
    externalId: string | null;
    title: string;
    url: string;
    authority: string;
    kind: string;
    publishedAt: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    excerpt: string;
    contentHash: string;
    impactedRuleKeys: string;
    warnings: string;
    status: string;
    fetchedAt: Date;
    source?: { key: string } | null;
  };
  type VerRow = {
    id: string;
    version: number;
    ay: string | null;
    entityTypes: string;
    states: string;
    scope: string;
    unit: string;
    rows: string;
    valueSummary: string;
    citation: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    status: string;
    notificationId: string | null;
    supersedesId: string | null;
    contentHash: string;
    createdAt: Date;
    publishedAt: Date | null;
    publishedById: string | null;
    notes: string | null;
    rule: { key: string };
  };

  const toSource = (s: SourceRow): StatuteSourceView => ({
    id: s.id,
    key: s.key,
    name: s.name,
    authority: s.authority as NotificationAuthority,
    url: s.url,
    format: s.format,
    kind: s.kind,
    active: s.active,
    checkCron: s.checkCron,
    lastCheckedAt: s.lastCheckedAt ? s.lastCheckedAt.toISOString() : null,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
  });
  const toNotification = (n: NoteRow): NotificationView => ({
    id: n.id,
    sourceId: n.sourceId,
    sourceKey: n.source?.key ?? null,
    externalId: n.externalId,
    title: n.title,
    url: n.url,
    authority: n.authority as NotificationAuthority,
    kind: n.kind as NotificationKind,
    publishedAt: n.publishedAt,
    effectiveFrom: n.effectiveFrom,
    effectiveTo: n.effectiveTo,
    excerpt: n.excerpt,
    contentHash: n.contentHash,
    impactedRuleKeys: parseJsonArray(n.impactedRuleKeys),
    warnings: parseJsonArray(n.warnings),
    status: n.status,
    fetchedAt: n.fetchedAt.toISOString(),
  });
  const toVersion = (v: VerRow): RuleVersionRecord => ({
    id: v.id,
    ruleKey: v.rule.key,
    version: v.version,
    applicability: {
      ay: v.ay,
      entityTypes: parseJsonArray(v.entityTypes),
      states: parseJsonArray(v.states),
      scope: v.scope === "state" ? "state" : "central",
    },
    unit: v.unit as RuleUnit,
    rows: parseRows(v.rows),
    valueSummary: v.valueSummary,
    citation: v.citation,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    status: v.status as RuleVersionRecord["status"],
    notificationId: v.notificationId,
    supersedes: v.supersedesId,
    contentHash: v.contentHash,
    createdAt: v.createdAt.toISOString(),
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    publishedBy: v.publishedById,
    notes: v.notes,
  });

  /** Rules are created on first use so a catalogue slot needs no migration. */
  const ensureRule = async (workspaceId: string, ruleKey: string) => {
    const def = ruleDefinition(ruleKey);
    return prisma.statutoryRule.upsert({
      where: { workspaceId_key: { workspaceId, key: ruleKey } },
      create: {
        workspaceId,
        key: ruleKey,
        label: def.label,
        unit: def.unit,
        authority: def.authority,
        description: def.description,
      },
      update: { label: def.label, unit: def.unit, authority: def.authority, description: def.description },
    });
  };

  return {
    async listSources(workspaceId) {
      const rows = (await prisma.statuteSource.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
      })) as SourceRow[];
      return rows.map(toSource);
    },
    async findSource(workspaceId, id) {
      const row = (await prisma.statuteSource.findFirst({ where: { id, workspaceId } })) as SourceRow | null;
      return row ? toSource(row) : null;
    },
    async findSourceByKey(workspaceId, key) {
      const row = (await prisma.statuteSource.findFirst({ where: { workspaceId, key } })) as SourceRow | null;
      return row ? toSource(row) : null;
    },
    async createSource(workspaceId, createdById, input) {
      const row = (await prisma.statuteSource.create({
        data: {
          workspaceId,
          createdById,
          key: input.key,
          name: input.name,
          authority: input.authority,
          url: input.url,
          format: input.format ?? "json",
          kind: input.kind ?? "notification",
          active: input.active ?? true,
          checkCron: input.checkCron ?? null,
        },
      })) as SourceRow;
      return toSource(row);
    },
    async updateSource(workspaceId, id, patch) {
      const row = (await prisma.statuteSource.update({
        where: { id, workspaceId },
        data: {
          ...(patch.lastCheckedAt !== undefined
            ? { lastCheckedAt: patch.lastCheckedAt ? new Date(patch.lastCheckedAt) : null }
            : {}),
          ...(patch.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        },
      })) as SourceRow;
      return toSource(row);
    },
    async listNotifications(workspaceId, opts) {
      const rows = (await prisma.statuteNotification.findMany({
        where: { workspaceId, ...(opts?.status ? { status: opts.status } : {}) },
        orderBy: { fetchedAt: "desc" },
        take: opts?.limit ?? 100,
        include: { source: { select: { key: true } } },
      })) as NoteRow[];
      return rows.map(toNotification);
    },
    async findNotification(workspaceId, id) {
      const row = (await prisma.statuteNotification.findFirst({
        where: { id, workspaceId },
        include: { source: { select: { key: true } } },
      })) as NoteRow | null;
      return row ? toNotification(row) : null;
    },
    async insertNotification(workspaceId, sourceId, parsed) {
      const existing = (await prisma.statuteNotification.findFirst({
        where: { workspaceId, sourceId, contentHash: parsed.contentHash },
        include: { source: { select: { key: true } } },
      })) as NoteRow | null;
      if (existing) return { inserted: false, notification: toNotification(existing) };
      const row = (await prisma.statuteNotification.create({
        data: {
          workspaceId,
          sourceId,
          externalId: parsed.externalId,
          title: parsed.title,
          url: parsed.url,
          authority: parsed.authority,
          kind: parsed.kind,
          publishedAt: parsed.publishedAt,
          effectiveFrom: parsed.effectiveFrom,
          effectiveTo: parsed.effectiveTo,
          excerpt: parsed.excerpt,
          contentHash: parsed.contentHash,
          impactedRuleKeys: JSON.stringify(parsed.impactedRuleKeys),
          warnings: JSON.stringify(parsed.warnings),
          status: "new",
        },
        include: { source: { select: { key: true } } },
      })) as NoteRow;
      return { inserted: true, notification: toNotification(row) };
    },
    async setNotificationStatus(workspaceId, id, status, appliedAt) {
      await prisma.statuteNotification.updateMany({
        where: { id, workspaceId },
        data: { status, appliedAt: appliedAt ? new Date(appliedAt) : null },
      });
    },
    async listRuleVersions(workspaceId, ruleKey) {
      const rows = (await prisma.statutoryRuleVersion.findMany({
        where: { workspaceId, ...(ruleKey ? { rule: { key: ruleKey } } : {}) },
        include: { rule: { select: { key: true } } },
        orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
      })) as VerRow[];
      return rows.map(toVersion);
    },
    async createRuleVersion(workspaceId, input) {
      await ensureRule(workspaceId, input.ruleKey);
      const rule = await prisma.statutoryRule.findUniqueOrThrow({
        where: { workspaceId_key: { workspaceId, key: input.ruleKey } },
      });
      const row = (await prisma.statutoryRuleVersion.create({
        data: {
          workspaceId,
          ruleId: rule.id,
          version: input.version,
          ay: input.applicability.ay,
          entityTypes: JSON.stringify(input.applicability.entityTypes),
          states: JSON.stringify(input.applicability.states),
          scope: input.applicability.scope,
          unit: input.unit,
          rows: JSON.stringify(input.rows),
          valueSummary: input.valueSummary,
          citation: input.citation,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          status: input.status,
          notificationId: input.notificationId ?? null,
          supersedesId: input.supersedesId,
          contentHash: input.contentHash,
          publishedAt: input.status === "published" ? new Date() : null,
          publishedById: input.publishedById,
          notes: input.notes,
        },
        include: { rule: { select: { key: true } } },
      })) as VerRow;
      return toVersion(row);
    },
    async updateRuleVersion(workspaceId, id, patch) {
      const row = (await prisma.statutoryRuleVersion.update({
        where: { id, workspaceId },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.effectiveTo !== undefined ? { effectiveTo: patch.effectiveTo } : {}),
        },
        include: { rule: { select: { key: true } } },
      })) as VerRow;
      return toVersion(row);
    },
  };
}
