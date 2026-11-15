/**
 * Firm-wide statutory due-date drift.
 *
 * Reads each engagement's stored compliance profile, regenerates its calendar,
 * and compares the fresh dates against the runs the firm is already working to.
 * The pure comparison lives in `lib/engine/statute-drift.ts`; this module only
 * supplies the rows and keeps the tenant scope explicit.
 *
 * A profile that cannot be parsed is skipped, not guessed. A run whose task no
 * longer exists in the generated calendar is a different problem (deregistration
 * or profile change) and is not reported as a date change.
 */

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import {
  buildClientComplianceCalendar,
  financialYearFor,
  type ClientComplianceProfileInput,
  type EntityKind,
  type GstFrequency,
} from "@/lib/engine/compliance-calendar";
import { detectDueDateDrift, type DueDateDrift } from "@/lib/engine/statute-drift";
import { withTenantDb } from "@/lib/server/tenant-db";

const ENTITY_KINDS = new Set<EntityKind>(["company", "llp", "partnership", "proprietorship", "trust", "individual"]);
const GST_FREQUENCIES = new Set<GstFrequency>(["monthly", "quarterly"]);

type StoredProfile = Record<string, unknown> & {
  entityKind: EntityKind;
  gstFrequency: GstFrequency;
};

function readProfile(raw: string | null): StoredProfile | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.entityKind !== "string" || !ENTITY_KINDS.has(value.entityKind as EntityKind)) return null;
  if (typeof value.gstFrequency !== "string" || !GST_FREQUENCIES.has(value.gstFrequency as GstFrequency)) return null;
  return parsed as StoredProfile;
}

/** A drift row joined back to the run the board can act on. */
export interface FirmDueDateDrift extends DueDateDrift {
  engagementId: string;
  /** Null when the profile changed under a run that is no longer open. */
  runId: string | null;
}

export interface StatueDriftSummary {
  drifts: FirmDueDateDrift[];
  /** Engagements checked, so an empty result is distinguishable from no data. */
  profilesChecked: number;
  unreadableProfiles: number;
}

/** Detect due-date drift for every engagement in one firm. */
export async function detectFirmDueDateDrift(
  ctx: AuthContext,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<StatueDriftSummary> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new ApiError(400, "NO_ORGANIZATION", "This account is not attached to a firm organization.");
  }
  const [profiles, runs] = await withTenantDb(ctx, (db) =>
    Promise.all([
      db.clientComplianceProfile.findMany({
        where: { engagement: { is: { organizationId } } },
        select: { engagementId: true, profile: true, engagement: { select: { name: true } } },
      }),
      db.complianceFilingRun.findMany({
        where: { organizationId, stage: { notIn: ["filed", "acknowledged"] } },
        select: { id: true, engagementId: true, taskId: true, title: true, dueDate: true },
        take: 500,
      }),
    ]),
  );

  let unreadableProfiles = 0;
  const drifts: FirmDueDateDrift[] = [];

  for (const row of profiles) {
    const profile = readProfile(row.profile);
    if (!profile) {
      unreadableProfiles += 1;
      continue;
    }
    let generated;
    try {
      generated = buildClientComplianceCalendar({
        ...(profile as unknown as Omit<ClientComplianceProfileInput, "clientId" | "clientName" | "financialYear">),
        clientId: row.engagementId,
        clientName: row.engagement.name,
        financialYear: (typeof profile.financialYear === "string" && profile.financialYear) || financialYearFor(today),
      });
    } catch {
      unreadableProfiles += 1;
      continue;
    }

    const engagementRuns = runs.filter((run) => run.engagementId === row.engagementId);
    const tracked = engagementRuns.map((run) => ({
      taskId: run.taskId,
      dueDate: run.dueDate,
      title: run.title,
      clientName: row.engagement.name,
    }));
    if (tracked.length === 0) continue;

    const runIdByTask = new Map(engagementRuns.map((run) => [run.taskId, run.id]));
    for (const drift of detectDueDateDrift(
      tracked,
      generated.map((task) => ({ taskId: task.id, dueDate: task.dueDate })),
    )) {
      drifts.push({
        ...drift,
        engagementId: row.engagementId,
        runId: runIdByTask.get(drift.taskId) ?? null,
      });
    }
  }

  return {
    drifts: drifts.slice(0, 25),
    profilesChecked: profiles.length,
    unreadableProfiles,
  };
}
