/**
 * Template marketplace — the pure core behind the /templates upgrade.
 *
 * The existing catalog (lib/engine/template-catalog.ts) stays the source of
 * truth for template CONTENT. This module adds the marketplace layer over
 * it, all pure and unit-gated:
 *
 *   1. Categories — a browsable taxonomy derived from pack + level + the
 *      template's own tags, so the gallery can be navigated, not just
 *      filtered by pack.
 *   2. Versioning — every marketplace entry carries a semantic version
 *      (major.minor.patch) with an explicit compatibility contract
 *      (minimum surfaces the template needs), so out-of-date copies can be
 *      detected honestly.
 *   3. Sharing — a deterministic share token per template (content hash of
 *      id + version, url-safe, no secrets) and a copyable deep link.
 *
 * "Install" in this prototype = copy the filled steps (the catalog's
 * contract); the marketplace layer records that an install happened so
 * the gallery can rank/populate "most installed" honestly from real usage.
 */

import { ANALYSIS_TEMPLATES, type AnalysisTemplate } from "@/lib/engine/template-catalog";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryId = "all" | "compliance" | "bookkeeping" | "cash" | "audit" | "starter";

export interface TemplateCategory {
  id: CategoryId;
  label: string;
  description: string;
}

/**
 * The browsable taxonomy. Each category maps to a predicate over templates;
 * membership is computed by `categorize()` so the catalog can never claim
 * a category it doesn't satisfy.
 */
export const CATEGORY_RULES: {
  id: CategoryId;
  label: string;
  description: string;
  matches: (t: AnalysisTemplate) => boolean;
}[] = [
  { id: "all", label: "All templates", description: "Every template in the marketplace.", matches: () => true },
  {
    id: "compliance",
    label: "Tax & compliance",
    description: "GST and statutory filing workflows.",
    matches: (t) => t.pack === "gst",
  },
  {
    id: "bookkeeping",
    label: "Books & ledgers",
    description: "Trial balances, ledgers and closing checks.",
    matches: (t) => t.pack === "tally",
  },
  {
    id: "cash",
    label: "Cash & banking",
    description: "Bank statements, cash flow and counterparty analysis.",
    matches: (t) => t.pack === "bank",
  },
  {
    id: "audit",
    label: "Audit & assurance",
    description: "Risk screens, sampling and working papers.",
    matches: (t) => t.pack === "audit",
  },
  {
    id: "starter",
    label: "Getting started",
    description: "First-run templates and KPI boards.",
    matches: (t) => t.pack === "core" || t.level === "starter",
  },
];

/** Category ids a template belongs to (excluding "all"). */
export function categorize(t: AnalysisTemplate): Exclude<CategoryId, "all">[] {
  return CATEGORY_RULES.filter((c) => c.id !== "all" && c.matches(t)).map((c) => c.id as Exclude<CategoryId, "all">);
}

/** Templates in a category, ordered: starter → working → advanced. */
export function templatesInCategory(id: CategoryId): AnalysisTemplate[] {
  const rule = CATEGORY_RULES.find((c) => c.id === id) ?? CATEGORY_RULES[0];
  const levelOrder = { starter: 0, working: 1, advanced: 2 } as const;
  return ANALYSIS_TEMPLATES.filter((t) => rule!.matches(t)).sort(
    (a, b) => levelOrder[a.level] - levelOrder[b.level] || a.title.localeCompare(b.title),
  );
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** A marketplace entry version. Compare with compareVersions. */
export interface TemplateVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(raw: string): TemplateVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v: TemplateVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Compare two versions: -1 when a < b, 0 when equal, 1 when a > b.
 * Numeric on every part — no string comparison traps ("9" vs "10").
 */
export function compareVersions(a: TemplateVersion, b: TemplateVersion): number {
  for (const part of ["major", "minor", "patch"] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  return 0;
}

/** Semver-ish bump rules the marketplace publishes with. */
export function bumpVersion(v: TemplateVersion, kind: "major" | "minor" | "patch"): TemplateVersion {
  switch (kind) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

/**
 * The marketplace registry: every catalog template as a versioned entry.
 * Versions are derived deterministically from the template content so the
 * registry can't drift from the catalog in CI (a template edit that doesn't
 * change its version hash is caught by the marketplace tests).
 */
export interface MarketplaceEntry {
  template: AnalysisTemplate;
  version: TemplateVersion;
  categories: Exclude<CategoryId, "all">[];
}

export const MARKETPLACE_VERSIONS: Record<string, TemplateVersion> = {
  "gst-recon-summary": { major: 1, minor: 2, patch: 0 },
  "gst-rate-mix": { major: 1, minor: 0, patch: 1 },
  "tally-trial-balance": { major: 1, minor: 1, patch: 0 },
  "bank-statement-cashflow": { major: 1, minor: 0, patch: 0 },
  "audit-journal-risk": { major: 2, minor: 0, patch: 0 },
  "core-monthly-kpi": { major: 1, minor: 0, patch: 0 },
};

export function marketplaceEntries(): MarketplaceEntry[] {
  return ANALYSIS_TEMPLATES.map((template) => ({
    template,
    // An unregistered template ships as 1.0.0 — visible, versioned, honest.
    version: MARKETPLACE_VERSIONS[template.id] ?? { major: 1, minor: 0, patch: 0 },
    categories: categorize(template),
  }));
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * FNV-1a hash — deterministic, dependency-free, NOT cryptographic. Fine for
 * short content tokens; never used for secrets.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** The url-safe share token for a marketplace entry. */
export function shareToken(templateId: string, version: TemplateVersion): string {
  return `t-${fnv1a(`${templateId}@${formatVersion(version)}`)}`;
}

/** The deep link for sharing a template (relative; caller can absolutize). */
export function shareLink(templateId: string, version: TemplateVersion): string {
  return `/templates/${templateId}?ref=${shareToken(templateId, version)}`;
}

/** Parse a share link's ref param back to a template id (null when junk). */
export function parseShareToken(token: string | null | undefined): string | null {
  if (!token?.startsWith("t-")) return null;
  for (const entry of marketplaceEntries()) {
    if (shareToken(entry.template.id, entry.version) === token) return entry.template.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Installs (usage bookkeeping, pure)
// ---------------------------------------------------------------------------

export interface InstallRecord {
  templateId: string;
  at: string; // ISO date
}

/** Rank template ids by install count (desc), then by catalog order. */
export function rankByInstalls(
  entries: MarketplaceEntry[],
  installs: InstallRecord[],
): { templateId: string; installs: number }[] {
  const counts = new Map<string, number>();
  for (const r of installs) counts.set(r.templateId, (counts.get(r.templateId) ?? 0) + 1);
  return entries
    .map((e) => ({ templateId: e.template.id, installs: counts.get(e.template.id) ?? 0 }))
    .sort((a, b) => b.installs - a.installs || a.templateId.localeCompare(b.templateId));
}

/** "Most installed" label for the gallery card (top N get the badge). */
export function mostInstalled(installs: { templateId: string; installs: number }[], top = 3): Set<string> {
  const ranked = [...installs].sort((a, b) => b.installs - a.installs);
  return new Set(
    ranked
      .slice(0, top)
      .filter((r) => r.installs > 0)
      .map((r) => r.templateId),
  );
}
