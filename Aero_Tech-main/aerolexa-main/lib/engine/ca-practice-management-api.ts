/**
 * Practice management API adapter — `POST /api/ca/compute` under
 * `kind: "practiceman"`.
 *
 * `ca-practice-management.ts` is the firm-wide operating system engine; it works
 * in MAJOR UNITS (INR rupees) on fee/time figures and strings for all dates. This
 * module makes it reachable from the compute endpoint: it validates an op-shaped
 * payload with Zod and, where a nested op carries money that other engines speak
 * in paise, converts RUPEES → PAISE at the dispatch boundary.
 *
 * Kept as a pure, exported dispatcher (rather than inline in the route) so the
 * rupee→paise conversion and dispatch are unit-testable without a server or a
 * database.
 */

import { z } from "zod";

import {
  type EngagementDeadlineConfig,
  type PracticeAccessRole,
  type DocumentConfig,
  buildPracticeWorkspace,
  validatePracticeConfig,
  PracticeManagementError,
} from "./ca-practice-management";

const rupees = z.number().finite().safe();
const nonNegativeRupees = z.number().finite().min(0);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------------------------------------------------------------------------
// Reusable sub-schemas (input shape mirrors the config types but in rupees where
// the engine already speaks rupees; nested money fields that the engine treats
// as rupees stay rupees here too).
// ---------------------------------------------------------------------------

const role = z.enum(["partner", "reviewer", "assistant"]);
const ownerType = z.enum(["partner", "reviewer", "assistant", "unassigned"]);
const wpStatus = z.enum(["draft", "in-review", "rework", "approved", "signed-off"]);
const docStatus = z.enum(["draft", "final", "signed", "superseded", "retained"]);
const docClass = z.enum(["working-paper", "final-report", "signed-copy", "supporting"]);
const engagementStatus = z.enum(["entered", "scoped", "in-progress", "under-review", "completed", "archived"]);
const phaseStatus = z.enum(["not-started", "in-progress", "completed"]);
const deadlineStatus = z.enum(["upcoming", "due", "overdue", "completed", "escalated"]);

const clientConfig = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  identifiers: z
    .object({
      pan: z.string().nullish(),
      cin: z.string().nullish(),
      gstin: z.string().nullish(),
    })
    .optional()
    .default({}),
  workpaperTemplateIds: z.array(z.string().min(1)).default([]),
  primaryContact: z.string().min(1),
  allowedRoles: z.array(role),
});

const engagementPhaseConfig = z.object({
  phaseId: z.string().min(1),
  name: z.string().min(1),
  budgetHours: z.number().finite(),
  actualHours: z.number().finite(),
  feeBudget: rupees,
  feeBilled: rupees,
  status: phaseStatus,
});

const engagementDeadlineConfig = z.object({
  deadlineId: z.string().min(1),
  label: z.string().min(1),
  dueDate: date,
  entityTag: z.string().nullish(),
  dependsOn: z.array(z.string().min(1)).default([]),
  status: deadlineStatus,
  owner: z.string().min(1),
  escalationNote: z.string().nullish(),
});

const workpaperReviewEvent = z.object({
  date: date,
  action: z.enum(["submitted-for-review", "review-note", "rework", "approved", "signed-off"]),
  byUserId: z.string().min(1),
  note: z.string().nullish(),
});

const workpaperConfig = z.object({
  workpaperId: z.string().min(1),
  workpaperNumber: z.string().min(1),
  title: z.string().min(1),
  familyId: z.string().nullish(),
  templateId: z.string().nullish(),
  status: wpStatus,
  ownerType: ownerType,
  ownerUserId: z.string().min(1),
  crossReferences: z.array(z.string().min(1)).default([]),
  dueDate: date,
  reviewHistory: z.array(workpaperReviewEvent).default([]),
});

const documentConfig = z.object({
  documentId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().positive(),
  documentClass: docClass,
  uploadedAt: date,
  ownerUserId: z.string().min(1),
  status: docStatus,
  // Required-but-nullable on the config type: `.default(null)` keeps the parsed
  // shape assignable to DocumentConfig instead of leaving it `undefined`.
  retentionUntil: z.string().nullish().default(null),
  allowedRoles: z.array(role),
});

const communicationConfig = z.object({
  date: date,
  from: z.string().min(1),
  to: z.string().min(1),
  subject: z.string().min(1),
  note: z.string().min(1),
});

const engagementConfig = z.object({
  engagementId: z.string().min(1),
  clientId: z.string().min(1),
  matter: z.string().min(1),
  status: engagementStatus,
  scope: z.string().min(1),
  periodLabel: z.string().min(1),
  leadPartner: z.string().min(1),
  reviewers: z.array(z.string().min(1)).default([]),
  feeBudget: nonNegativeRupees,
  feeBilled: nonNegativeRupees,
  feeRealised: nonNegativeRupees,
  timeRecordedHours: z.number().finite().min(0),
  communications: z.array(communicationConfig).default([]),
  phases: z.array(engagementPhaseConfig).default([]),
  deadlines: z.array(engagementDeadlineConfig).default([]),
  workpapers: z.array(workpaperConfig).default([]),
  documents: z.array(documentConfig).default([]),
});

const firmConfig = z.object({
  firmId: z.string().min(1),
  name: z.string().min(1),
  calendarWindowStart: date,
  calendarWindowEnd: date,
});

const analyticsScope = z.object({
  realisation: z.boolean(),
  pipeline: z.boolean(),
  overdue: z.boolean(),
  complianceDueList: z.boolean(),
  staffingLoad: z.boolean(),
});

// ---------------------------------------------------------------------------
// Top-level config (mirrors PracticeManConfig exactly; money fields are rupees)
// ---------------------------------------------------------------------------

export const practiceManConfig = z.object({
  firm: firmConfig,
  clients: z.array(clientConfig),
  engagements: z.array(engagementConfig),
  analytics: analyticsScope,
});

export type PracticeManRequest = z.infer<typeof practiceManConfig>;

// ---------------------------------------------------------------------------
// Dispatching op surface
// ---------------------------------------------------------------------------

/** The operations the adapter currently dispatches. Money fields are rupees. */
export const practiceManOperations = z.discriminatedUnion("op", [
  // Full firm-wide build (the main op)
  z.object({ op: z.literal("build"), config: practiceManConfig }),

  // Engagement lifecycle helpers
  z.object({
    op: z.literal("realisation"),
    engagement: engagementConfig,
  }),

  // Deadline helpers
  z.object({
    op: z.literal("reassign-deadline"),
    deadline: engagementDeadlineConfig,
    toOwner: z.string().min(1),
    reason: z.string().min(1),
    asOf: date,
  }),

  // Document versioning helper
  z.object({
    op: z.literal("document-versions-valid"),
    documents: z.array(documentConfig),
  }),

  // Client access summary
  z.object({
    op: z.literal("client-access-summary"),
    clients: z.array(clientConfig),
  }),

  // Assignment review status
  z.object({
    op: z.literal("assignment-review-status"),
    engagements: z.array(engagementConfig),
    userId: z.string().min(1),
  }),
]);

export type PracticeManOperationRequest = z.infer<typeof practiceManOperations>;

// ---------------------------------------------------------------------------
// Engine error surface
// ---------------------------------------------------------------------------

export { PracticeManagementError };

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a validated op to the engine. The `build` op runs the full
 * firm-wide operating system view; the helper ops run targeted checks that the
 * engine already implements. Money fields are already rupees (matching the
 * engine contract), so no rupee→paise conversion is required here — that
 * conversion lives in engines whose contract is paise (payroll, TDS, GST, …).
 */
export function computePracticeManagement(input: PracticeManOperationRequest):
  | { op: "build"; result: ReturnType<typeof buildPracticeWorkspace> }
  | { op: "realisation"; realisationPct: number; timeBudgetVariancePct: number; warnings: string[] }
  | {
      op: "reassign-deadline";
      deadline: EngagementDeadlineConfig;
      reassignment: {
        deadlineId: string;
        fromOwner: string;
        toOwner: string;
        reason: string;
        reassignedAt: string;
      };
      escalated: boolean;
    }
  | { op: "document-versions-valid"; valid: boolean; errors: string[] }
  | {
      op: "client-access-summary";
      summary: {
        clientId: string;
        name: string;
        allowedRoles: PracticeAccessRole[];
        engagementCount: number;
      }[];
    }
  | {
      op: "assignment-review-status";
      status: {
        userId: string;
        pendingWorkpapers: number;
        pendingDocuments: number;
        engagementCount: number;
      };
    } {
  switch (input.op) {
    case "build": {
      // Structural input errors — an unknown client mapping, a deadline
      // dependency cycle, a dangling workpaper cross-reference or out-of-order
      // document versions — are a caller error, not a computed result. The
      // engine reports them as warnings (so the workspace is still inspectable);
      // the API adapter turns them into a 400 (PracticeManagementError) so a
      // malformed firm view is never shipped as if it were valid.
      const errors = validatePracticeConfig(input.config);
      if (errors.length) throw new PracticeManagementError(errors.join(" "));
      return { op: "build", result: buildPracticeWorkspace(input.config) };
    }

    case "realisation": {
      // Reuse the engine's engagement-level realisation computation by building
      // a full result and extracting the engagement result. This avoids
      // duplicating the logic.
      const full = buildPracticeWorkspace({
        firm: {
          firmId: "firm-realisation-check",
          name: "Realisation check",
          calendarWindowStart: "2024-04-01",
          calendarWindowEnd: "2025-03-31",
        },
        clients: [],
        engagements: [input.engagement],
        analytics: { realisation: true, pipeline: true, overdue: true, complianceDueList: true, staffingLoad: true },
      });
      const er = full.engagements[0]!;
      return {
        op: "realisation",
        realisationPct: er.realisationPct,
        timeBudgetVariancePct: er.timeBudgetVariancePct,
        warnings: er.warnings,
      };
    }

    case "reassign-deadline": {
      // The engine does not currently expose a standalone reassign function, so
      // we implement the reassignment semantics inline using the same types the
      // engine uses. This keeps the adapter self-consistent with the engine's
      // deadline model.
      const d = input.deadline;
      const escalated = input.reason.toLowerCase().includes("risk") || input.reason.toLowerCase().includes("escalat");
      const updated: EngagementDeadlineConfig = {
        ...d,
        owner: input.toOwner,
        status: escalated ? "escalated" : d.status,
        escalationNote: escalated ? input.reason : d.escalationNote,
      };
      const reassignment = {
        deadlineId: d.deadlineId,
        fromOwner: d.owner,
        toOwner: input.toOwner,
        reason: input.reason,
        reassignedAt: input.asOf,
      };
      return { op: "reassign-deadline", deadline: updated, reassignment, escalated };
    }

    case "document-versions-valid": {
      const errors: string[] = [];
      const byName = new Map<string, DocumentConfig[]>();
      for (const d of input.documents) {
        byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
      }
      for (const [, versioned] of byName) {
        const sorted = versioned.slice().sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i]!.version <= sorted[i - 1]!.version) {
            errors.push(
              `${sorted[i]!.name} version ${sorted[i]!.version} is not newer than version ${sorted[i - 1]!.version}.`,
            );
          }
        }
      }
      return { op: "document-versions-valid", valid: errors.length === 0, errors };
    }

    case "client-access-summary": {
      const summary = input.clients.map((c) => ({
        clientId: c.clientId,
        name: c.name,
        allowedRoles: c.allowedRoles,
        engagementCount: 0,
      }));
      return { op: "client-access-summary", summary };
    }

    case "assignment-review-status": {
      let pendingWorkpapers = 0;
      let pendingDocuments = 0;
      const seen = new Set<string>();
      for (const e of input.engagements) {
        if (e.leadPartner === input.userId || e.reviewers.includes(input.userId)) {
          seen.add(e.engagementId);
        }
        for (const w of e.workpapers) {
          if (w.ownerUserId === input.userId && w.status === "in-review") pendingWorkpapers += 1;
        }
        for (const d of e.documents) {
          if (d.ownerUserId === input.userId && (d.status === "draft" || d.status === "final")) pendingDocuments += 1;
        }
      }
      return {
        op: "assignment-review-status",
        status: { userId: input.userId, pendingWorkpapers, pendingDocuments, engagementCount: seen.size },
      };
    }
  }
}
