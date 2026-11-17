/**
 * Filing execution — from "the calendar says GSTR-3B is due" to "here is the
 * acknowledgement".
 *
 * The compliance calendar generates obligations and records a filed/waived
 * flag. That is enough to answer "what is due", but not "who is doing it, has a
 * second person reviewed it, did the client approve it, and what did the portal
 * return". This module adds exactly that pipeline without duplicating the due
 * dates: a run points at a generated task id, and reaching `filed` writes the
 * same ClientComplianceStatus the calendar reads.
 *
 * tenancy-audit: global-operator — filing-runs module manages compliance filing
 * runs and statuses. This is a deployment-wide aggregate rather than a per-tenant query.
 *
 * Stage order is linear and one step at a time:
 *   computed → prepared → reviewed → client-approved → filed → acknowledged
 *
 * Role gates follow the firm's separation of duties: preparation can be done by
 * an assistant, review and client approval need a manager, and the reviewer can
 * never be the preparer.
 */

import type { Prisma } from "@/generated/prisma/client";
import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { filingChannel, resolveFilingGateway } from "@/lib/engine/filing/gateway";
import { signFilingPayload, type FilingSignatureEnvelope } from "@/lib/engine/filing/signing";
import { resolveFilingSigner, resolveSigningAccount } from "@/lib/engine/filing/signing-service";
import { logActivity } from "@/lib/server/activity";
import { getComplianceCalendar } from "@/lib/server/compliance-calendar";
import { requireEngagementRole } from "@/lib/server/engagement";
import { buildFilingProof, filingProofDigest, portalIdentityFrom } from "@/lib/server/filing-proof";
import { assertFilingSubmissionAllowed } from "@/lib/server/filing-rollout";
import { requireOrgRole } from "@/lib/server/members";
import { withTenantDb } from "@/lib/server/tenant-db";
import type { PracticeRole } from "@/lib/types";

export const FILING_STAGES = ["computed", "prepared", "reviewed", "client-approved", "filed", "acknowledged"] as const;

export type FilingStage = (typeof FILING_STAGES)[number];

const STAGE_ORDER: Record<FilingStage, number> = {
  computed: 0,
  prepared: 1,
  reviewed: 2,
  "client-approved": 3,
  filed: 4,
  acknowledged: 5,
};

const STAGE_ROLE: Record<FilingStage, PracticeRole | null> = {
  computed: null,
  prepared: "ASSISTANT",
  reviewed: "MANAGER",
  "client-approved": "MANAGER",
  filed: "MANAGER",
  acknowledged: "ASSISTANT",
};

export const FILING_STAGE_LABELS: Record<FilingStage, string> = {
  computed: "Computed",
  prepared: "Prepared",
  reviewed: "Reviewed",
  "client-approved": "Client approved",
  filed: "Filed",
  acknowledged: "Acknowledged",
};

export interface FilingEventView {
  id: string;
  fromStage: string | null;
  toStage: string;
  note: string | null;
  actorName: string;
  createdAt: string;
}

export interface FilingRunView {
  id: string;
  engagementId: string;
  engagementName: string;
  taskId: string;
  title: string;
  authority: string;
  dueDate: string;
  stage: FilingStage;
  assigneeId: string | null;
  assigneeName: string | null;
  reviewerId: string | null;
  acknowledgementReference: string | null;
  filedAt: string | null;
  acknowledgedAt: string | null;
  /** unverified | verified | unverifiable | defective */
  verificationStatus: string;
  verificationNote: string | null;
  /** SHA-256 of the stored proof bundle, when a gateway attempt exists. */
  proofDigest: string | null;
  proofCapturedAt: string | null;
  /** When the client approved through the portal, and the receipt digest. */
  clientApprovedAt: string | null;
  clientApprovalDigest: string | null;
  updatedAt: string;
  events: FilingEventView[];
}

export interface AvailableObligation {
  engagementId: string;
  engagementName: string;
  taskId: string;
  title: string;
  authority: string;
  dueDate: string;
  state: string;
}

export interface FilingBoardResult {
  runs: FilingRunView[];
  available: AvailableObligation[];
}

function assertStage(value: string): FilingStage {
  if (!(FILING_STAGES as readonly string[]).includes(value)) {
    throw new ApiError(400, "VALIDATION", `Unknown filing stage “${value}”. Use one of: ${FILING_STAGES.join(", ")}.`);
  }
  return value as FilingStage;
}

function requireOrganization(ctx: AuthContext): string {
  if (!ctx.organization) {
    throw new ApiError(404, "NO_ORGANIZATION", "Create an organization first.");
  }
  return ctx.organization.id;
}

async function requireRun(ctx: AuthContext, id: string) {
  const run = await withTenantDb(ctx, (db) =>
    db.complianceFilingRun.findUnique({
      where: { id },
      include: { engagement: { select: { id: true, name: true, organizationId: true } } },
    }),
  );
  if (!run || run.organizationId !== requireOrganization(ctx)) {
    throw new ApiError(404, "NOT_FOUND", "Filing run not found.");
  }
  return run;
}

function nextStage(stage: FilingStage): FilingStage | null {
  return FILING_STAGES[STAGE_ORDER[stage] + 1] ?? null;
}

/** The linear successor of a stage, or null at the end of the pipeline. */
export function nextFilingStage(stage: FilingStage): FilingStage | null {
  return nextStage(stage);
}

/** The minimum practice role a stage transition requires (null for computed). */
export function filingStageRole(stage: FilingStage): PracticeRole | null {
  return STAGE_ROLE[stage];
}

/** Hydrate runs with member names and their audit trail. */
async function viewRuns(ctx: AuthContext, runs: Awaited<ReturnType<typeof loadRuns>>): Promise<FilingRunView[]> {
  const userIds = [
    ...new Set(
      runs
        .flatMap((run) => [run.assigneeId, ...run.events.map((event) => event.actorId)])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const users =
    userIds.length > 0
      ? await withTenantDb(ctx, (db) =>
        db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        }),
      )
      : [];
  const nameById = new Map(users.map((user) => [user.id, user.name || user.email]));

  return runs.map((run) => ({
    id: run.id,
    engagementId: run.engagementId,
    engagementName: run.engagement?.name ?? "Client",
    taskId: run.taskId,
    title: run.title,
    authority: run.authority,
    dueDate: run.dueDate,
    stage: assertStage(run.stage),
    assigneeId: run.assigneeId,
    assigneeName: run.assigneeId ? (nameById.get(run.assigneeId) ?? null) : null,
    reviewerId: run.reviewerId,
    acknowledgementReference: run.acknowledgementReference,
    filedAt: run.filedAt ? run.filedAt.toISOString() : null,
    acknowledgedAt: run.acknowledgedAt ? run.acknowledgedAt.toISOString() : null,
    verificationStatus: run.verificationStatus,
    verificationNote: run.verificationNote,
    proofDigest: run.proofDigest,
    proofCapturedAt: run.proofCapturedAt ? run.proofCapturedAt.toISOString() : null,
    clientApprovedAt: run.clientApprovedAt ? run.clientApprovedAt.toISOString() : null,
    clientApprovalDigest: run.clientApprovalDigest,
    updatedAt: run.updatedAt.toISOString(),
    events: run.events.map((event) => ({
      id: event.id,
      fromStage: event.fromStage,
      toStage: event.toStage,
      note: event.note,
      actorName: nameById.get(event.actorId) ?? "Member",
      createdAt: event.createdAt.toISOString(),
    })),
  }));
}

function loadRuns(ctx: AuthContext, organizationId: string, opts: { stage?: string; engagementId?: string } = {}) {
  return withTenantDb(ctx, (db) =>
    db.complianceFilingRun.findMany({
      where: {
        organizationId,
        ...(opts.stage ? { stage: opts.stage } : {}),
        ...(opts.engagementId ? { engagementId: opts.engagementId } : {}),
      },
      include: {
        engagement: { select: { id: true, name: true, organizationId: true } },
        events: { orderBy: { createdAt: "desc" }, take: 20 },
      },
      orderBy: [{ dueDate: "asc" }, { updatedAt: "desc" }],
      take: 400,
    }),
  );
}

/**
 * The board: in-flight runs plus obligations that have no run yet.
 * `available` is derived from the same generated calendar the compliance screen
 * shows, so a new obligation appears here without a backfill job.
 */
export interface FilingProofView {
  proof: unknown;
  digest: string | null;
  capturedAt: string | null;
}

/** Read the immutable proof bundle for one filing (any engagement member). */
export async function readFilingProof(ctx: AuthContext, runId: string): Promise<FilingProofView> {
  const run = await requireRun(ctx, runId);
  await requireEngagementRole(ctx, run.engagementId, "ASSISTANT");
  if (!run.proofBundle) {
    throw new ApiError(
      404,
      "NO_PROOF",
      "No proof bundle is stored for this filing yet. Submit it to the portal first.",
    );
  }
  return {
    proof: run.proofBundle,
    digest: run.proofDigest,
    capturedAt: run.proofCapturedAt ? run.proofCapturedAt.toISOString() : null,
  };
}

export interface FilingApprovalReceiptView {
  receipt: unknown;
  digest: string | null;
  approvedAt: string | null;
}

/**
 * Read the client's approval receipt (any engagement member). The receipt is
 * the client's artefact as much as the firm's, so it is readable even after the
 * run is filed; it is never edited.
 */
export async function readFilingApprovalReceipt(ctx: AuthContext, runId: string): Promise<FilingApprovalReceiptView> {
  const run = await requireRun(ctx, runId);
  await requireEngagementRole(ctx, run.engagementId, "ASSISTANT");
  if (!run.clientApprovalReceipt) {
    throw new ApiError(
      404,
      "NO_APPROVAL_RECEIPT",
      "The client has not approved this filing through the portal, so there is no receipt yet.",
    );
  }
  return {
    receipt: run.clientApprovalReceipt,
    digest: run.clientApprovalDigest,
    approvedAt: run.clientApprovedAt ? run.clientApprovedAt.toISOString() : null,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict calendar-date check — 2026-02-31 parses as March, so it must fail. */
function assertIsoDueDate(value: string): string {
  if (!ISO_DATE.test(value)) {
    throw new ApiError(400, "VALIDATION", `“${value}” is not a date. Use yyyy-mm-dd.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "VALIDATION", `“${value}” is not a real calendar date.`);
  }
  return value;
}

/**
 * Move one run's deadline after the statutory calendar was regenerated.
 *
 * The drift detector reports the disagreement; the firm decides. This is that
 * decision, recorded as an event so the board explains why a date changed
 * rather than silently overwriting it. A filed run is evidence and its
 * deadline is not rewritten.
 */
export async function moveFilingRunDueDate(
  ctx: AuthContext,
  runId: string,
  dueDate: string,
  note?: string | null,
): Promise<FilingRunView> {
  const run = await requireRun(ctx, runId);
  await requireEngagementRole(ctx, run.engagementId, "MANAGER");
  const stage = assertStage(run.stage);
  if (stage === "filed" || stage === "acknowledged") {
    throw new ApiError(
      409,
      "ALREADY_FILED",
      "This run is already filed; its recorded deadline is part of the evidence and is not rewritten.",
    );
  }
  const next = assertIsoDueDate(dueDate);

  if (next !== run.dueDate) {
    const explanation =
      note?.trim() || `Deadline moved from ${run.dueDate} to ${next} after the statutory calendar was regenerated.`;
    await withTenantDb(ctx, (db) =>
    db.$transaction([
      prisma.complianceFilingRun.update({
        where: { id: run.id },
        data: { dueDate: next, updatedById: ctx.user.id },
      }),
      prisma.complianceFilingEvent.create({
        data: {
          runId: run.id,
          organizationId: run.organizationId,
          fromStage: stage,
          toStage: stage,
          note: explanation.slice(0, 2000),
          actorId: ctx.user.id,
        },
      }),
    ]),
  );
    await logActivity(
      ctx,
      "COMPLIANCE_FILING_DUE_DATE_MOVED",
      `${run.title} deadline moved ${run.dueDate} → ${next}`,
      null,
      { engagementId: run.engagementId, runId: run.id, from: run.dueDate, to: next },
    );
  }

  const views = await viewRuns(ctx, await loadRuns(run.organizationId, { engagementId: run.engagementId }));
  const match = views.find((candidate) => candidate.id === run.id);
  if (!match) throw new ApiError(500, "INTERNAL", "Filing run could not be read back.");
  return match;
}

export async function getFilingBoard(
  ctx: AuthContext,
  opts: { stage?: string; engagementId?: string } = {},
): Promise<FilingBoardResult> {
  const organizationId = requireOrganization(ctx);
  await requireOrgRole(ctx, organizationId, "MEMBER");

  const [calendar, runs] = await Promise.all([getComplianceCalendar(ctx), loadRuns(organizationId, opts)]);

  const covered = new Set(runs.map((run) => `${run.engagementId}:${run.taskId}`));
  const available: AvailableObligation[] = calendar.tasks
    .filter((task) => task.state !== "filed" && task.state !== "waived")
    .filter((task) => !covered.has(`${task.clientId}:${task.id}`))
    .slice(0, 200)
    .map((task) => ({
      engagementId: task.clientId,
      engagementName: task.clientName,
      taskId: task.id,
      title: task.title,
      authority: task.authority,
      dueDate: task.dueDate,
      state: task.state,
    }));

  return { runs: await viewRuns(ctx, runs), available };
}

/** Put one generated obligation on the execution board. */
export async function ensureFilingRun(
  ctx: AuthContext,
  input: { engagementId: string; taskId: string },
): Promise<FilingRunView> {
  const organizationId = requireOrganization(ctx);
  const { engagement } = await requireEngagementRole(ctx, input.engagementId, "ASSISTANT");

  const calendar = await getComplianceCalendar(ctx);
  const task = calendar.tasks.find(
    (candidate) => candidate.clientId === engagement.id && candidate.id === input.taskId,
  );
  if (!task) {
    throw new ApiError(400, "VALIDATION", "That task does not belong to this client's current calendar.");
  }
  if (task.state === "filed" || task.state === "waived") {
    throw new ApiError(409, "ALREADY_CLOSED", "That obligation is already closed.");
  }

  const existing = await prisma.complianceFilingRun.findUnique({
    where: { engagementId_taskId: { engagementId: engagement.id, taskId: task.id } },
  });
  if (existing) {
    const views = await viewRuns(ctx, await loadRuns(organizationId, { engagementId: engagement.id }));
    const match = views.find((run) => run.id === existing.id);
    if (!match) throw new ApiError(500, "INTERNAL", "Filing run could not be read back.");
    return match;
  }

  await prisma.complianceFilingRun.create({
    data: {
      organizationId,
      engagementId: engagement.id,
      taskId: task.id,
      title: task.title,
      authority: task.authority,
      dueDate: task.dueDate,
      stage: "computed",
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
      events: {
        create: {
          organizationId,
          fromStage: null,
          toStage: "computed",
          note: "Run opened from the statutory calendar.",
          actorId: ctx.user.id,
        },
      },
    },
  });

  await logActivity(
    ctx,
    "COMPLIANCE_FILING_STARTED",
    `Opened filing run for ${task.title} (${engagement.name})`,
    null,
    {
      engagementId: engagement.id,
      taskId: task.id,
    },
  );

  const runs = await loadRuns(organizationId, { engagementId: engagement.id });
  const view = await viewRuns(ctx, runs);
  const created = view.find((run) => run.taskId === task.id && run.engagementId === engagement.id);
  if (!created) throw new ApiError(500, "INTERNAL", "Filing run could not be read back.");
  return created;
}

/**
 * Open execution runs for every obligation due within the horizon that has no
 * run yet. Explicit rather than silent: a partner clicks it at the start of a
 * cycle, so the board starts populated without a scheduler inventing work for
 * clients nobody has looked at.
 */
export async function openDueSoonFilingRuns(
  ctx: AuthContext,
  opts: { withinDays?: number; cap?: number } = {},
): Promise<{ opened: number; remaining: number }> {
  const organizationId = requireOrganization(ctx);
  await requireOrgRole(ctx, organizationId, "MEMBER");
  const withinDays = Math.min(Math.max(Math.trunc(opts.withinDays ?? 14), 1), 60);
  const cap = Math.min(Math.max(Math.trunc(opts.cap ?? 25), 1), 100);

  const calendar = await getComplianceCalendar(ctx);
  const horizon = new Date(Date.parse(`${calendar.asOf}T00:00:00Z`) + withinDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const due = calendar.tasks.filter(
    (task) => task.state !== "filed" && task.state !== "waived" && task.dueDate <= horizon,
  );

  const existing = await prisma.complianceFilingRun.findMany({
    where: { organizationId },
    select: { engagementId: true, taskId: true },
    take: 10_000,
  });
  const covered = new Set(existing.map((run) => `${run.engagementId}:${run.taskId}`));
  const candidates = due.filter((task) => !covered.has(`${task.clientId}:${task.id}`));
  const selection = candidates.slice(0, cap);

  for (const task of selection) {
    await prisma.complianceFilingRun.create({
      data: {
        organizationId,
        engagementId: task.clientId,
        taskId: task.id,
        title: task.title,
        authority: task.authority,
        dueDate: task.dueDate,
        stage: "computed",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
        events: {
          create: {
            organizationId,
            fromStage: null,
            toStage: "computed",
            note: "Run opened by the due-soon sweep.",
            actorId: ctx.user.id,
          },
        },
      },
    });
  }

  if (selection.length > 0) {
    await logActivity(ctx, "COMPLIANCE_FILING_STARTED", `Opened ${selection.length} due-soon filing run(s)`, null, {
      opened: selection.length,
      withinDays,
    });
  }
  return { opened: selection.length, remaining: Math.max(0, candidates.length - selection.length) };
}

/** Assign the preparer. Only an engagement member can own the work. */
export async function assignFilingRun(ctx: AuthContext, runId: string, assigneeId: string): Promise<FilingRunView> {
  const run = await requireRun(ctx, runId);
  await requireEngagementRole(ctx, run.engagementId, "MANAGER");

  // Access can come from an explicit engagement assignment OR the firm-wide
  // role fallback (the owner who created the engagement is not automatically
  // an EngagementMember). An AUDITOR is read-only, so never a valid owner.
  const [assignment, orgMembership] = await Promise.all([
    prisma.engagementMember.findFirst({
      where: { engagementId: run.engagementId, userId: assigneeId },
      select: { userId: true },
    }),
    prisma.organizationMember.findFirst({
      where: { organizationId: run.organizationId, userId: assigneeId },
      select: { role: true },
    }),
  ]);
  const assignable = Boolean(assignment) || (orgMembership !== null && orgMembership.role !== "AUDITOR");
  if (!assignable) {
    throw new ApiError(400, "VALIDATION", "Assign the run to a member of this engagement.");
  }

  await prisma.complianceFilingRun.update({
    where: { id: run.id },
    data: { assigneeId, updatedById: ctx.user.id },
  });
  const views = await viewRuns(ctx, await loadRuns(run.organizationId, { engagementId: run.engagementId }));
  const match = views.find((candidate) => candidate.id === run.id);
  if (!match) throw new ApiError(500, "INTERNAL", "Filing run could not be read back.");
  return match;
}

export interface BulkFilingOutcome {
  updated: number;
  failed: { runId: string; message: string }[];
}

/**
 * Batch assign preparers.
 *
 * A firm with 200 clients cannot click 200 times, but a batch must never be
 * all-or-nothing: each run is still gated by its own engagement role and
 * assignment rule, and a rejected run is reported rather than aborting the
 * batch. The same is true for bulk stage moves — one missing acknowledgement
 * must not hide the 30 that were fine.
 */
export async function bulkAssignFilingRuns(
  ctx: AuthContext,
  input: { runIds: string[]; assigneeId: string },
): Promise<BulkFilingOutcome> {
  const ids = [...new Set(input.runIds)].slice(0, 200);
  const failed: BulkFilingOutcome["failed"] = [];
  let updated = 0;
  for (const runId of ids) {
    try {
      await assignFilingRun(ctx, runId, input.assigneeId);
      updated += 1;
    } catch (err) {
      failed.push({
        runId,
        message: err instanceof Error ? err.message : "The run could not be assigned.",
      });
    }
  }
  if (updated > 0) {
    await logActivity(ctx, "COMPLIANCE_FILING_BULK_ASSIGNED", `Assigned ${updated} filing run(s)`, null, {
      assigned: updated,
      failed: failed.length,
    });
  }
  return { updated, failed };
}

/** Move many runs one stage forward, reporting each rejection. */
export async function bulkAdvanceFilingRuns(
  ctx: AuthContext,
  input: { runIds: string[]; stage: FilingStage; note?: string | null },
): Promise<BulkFilingOutcome> {
  const ids = [...new Set(input.runIds)].slice(0, 200);
  const failed: BulkFilingOutcome["failed"] = [];
  let updated = 0;
  for (const runId of ids) {
    try {
      await advanceFilingRun(ctx, runId, { stage: input.stage, note: input.note ?? null });
      updated += 1;
    } catch (err) {
      failed.push({
        runId,
        message: err instanceof Error ? err.message : "The run could not be moved.",
      });
    }
  }
  return { updated, failed };
}

export interface AdvanceFilingInput {
  stage: FilingStage;
  note?: string | null;
  acknowledgementReference?: string | null;
}

/**
 * The canonical document a portal submission carries for one run. Pure so the
 * exact bytes the gateway hashes are reproducible in tests and audits.
 */
export function filingSubmissionPayload(run: {
  id: string;
  engagementId: string;
  taskId: string;
  title: string;
  authority: string;
  dueDate: string;
}): Record<string, unknown> {
  return {
    formType: run.authority || "STATUTORY_RETURN",
    runId: run.id,
    engagementId: run.engagementId,
    taskId: run.taskId,
    title: run.title,
    dueDate: run.dueDate,
    schemaVersion: "2026-11",
  };
}

/**
 * Submit a client-approved run to the active filing gateway and capture the
 * portal acknowledgement.
 *
 * This is the only transition that leaves the building. A rejected or errored
 * receipt is recorded as a blocked run (with the portal's own message) instead
 * of advancing the stage — so the board never claims a filing that did not
 * happen. A successful receipt with an acknowledgement closes the run in the
 * same transaction; without one the run stops at `filed` and waits for the
 * reference.
 */
export async function submitFilingRun(
  ctx: AuthContext,
  runId: string,
  input: { note?: string | null } = {},
): Promise<FilingRunView> {
  const run = await requireRun(ctx, runId);
  await requireEngagementRole(ctx, run.engagementId, "MANAGER");
  const from = assertStage(run.stage);
  if (from !== "client-approved") {
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      `Only a client-approved run can be submitted (this run is “${from}”).`,
    );
  }

  // Per-client gate: a shadow client never transmits, even on a live gateway.
  // Simulation/reference providers and unenforced deployments are unaffected.
  await assertFilingSubmissionAllowed(ctx, run.engagementId);

  const payload = filingSubmissionPayload(run);
  const channel = filingChannel();

  // efiling-audit is the DSC-signed channel: sign the canonical payload once,
  // before the gateway call, so the signature and the proof bundle describe the
  // exact document that was transmitted. A signing failure blocks the run — it
  // never falls back to an unsigned audit return.
  let signature: FilingSignatureEnvelope | undefined;
  if (channel === "efiling-audit") {
    try {
      const signer = resolveFilingSigner();
      const account = resolveSigningAccount();
      if (!signer || !account) {
        throw new Error(
          "No DSC signing service is configured. Set FILING_SIGNING_URL, FILING_SIGNING_TOKEN, FILING_SIGNING_USER and FILING_SIGNING_CERT_SERIAL.",
        );
      }
      signature = await signFilingPayload(signer, account, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The DSC signing service could not sign the return.";
      await prisma.$transaction([
        prisma.complianceFilingRun.update({
          where: { id: run.id },
          data: { blockedReason: message.slice(0, 1000), updatedById: ctx.user.id },
        }),
        prisma.complianceFilingEvent.create({
          data: {
            runId: run.id,
            organizationId: run.organizationId,
            fromStage: from,
            toStage: from,
            note: `DSC signing failed: ${message}`.slice(0, 2000),
            actorId: ctx.user.id,
          },
        }),
      ]);
      throw new ApiError(
        502,
        "FILING_SIGNING_FAILED",
        `${message} How to fix: check the signing service and certificate serial, then retry — the run stays at client-approved.`,
      );
    }
  }

  let receipt;
  try {
    receipt = await resolveFilingGateway().submit({
      channel,
      payload,
      token: run.id,
      ...(signature ? { signature } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The filing portal could not be reached.";
    await prisma.$transaction([
      prisma.complianceFilingRun.update({
        where: { id: run.id },
        data: { blockedReason: message.slice(0, 1000), updatedById: ctx.user.id },
      }),
      prisma.complianceFilingEvent.create({
        data: {
          runId: run.id,
          organizationId: run.organizationId,
          fromStage: from,
          toStage: from,
          note: `Submission failed: ${message}`.slice(0, 2000),
          actorId: ctx.user.id,
        },
      }),
    ]);
    throw new ApiError(
      502,
      "FILING_SUBMISSION_FAILED",
      `${message} How to fix: check the portal credentials and retry — the run stays at client-approved.`,
    );
  }

  // Capture the attempt either way: a rejection is evidence too.
  const proof = buildFilingProof({
    run,
    payload,
    receipt,
    signature,
    actorId: ctx.user.id,
    portal: portalIdentityFrom(),
  });
  const digest = filingProofDigest(proof);
  const capturedAt = new Date(proof.capturedAt);

  if (receipt.status === "rejected" || receipt.status === "error") {
    const message = receipt.portalMessage || `The portal rejected the submission (${receipt.status}).`;
    await prisma.$transaction([
      prisma.complianceFilingRun.update({
        where: { id: run.id },
        data: {
          blockedReason: message.slice(0, 1000),
          proofBundle: proof as unknown as Prisma.InputJsonValue,
          proofDigest: digest,
          proofCapturedAt: capturedAt,
          updatedById: ctx.user.id,
        },
      }),
      prisma.complianceFilingEvent.create({
        data: {
          runId: run.id,
          organizationId: run.organizationId,
          fromStage: from,
          toStage: from,
          note: `Portal rejected the submission: ${message}`.slice(0, 2000),
          actorId: ctx.user.id,
        },
      }),
    ]);
    throw new ApiError(
      502,
      "FILING_REJECTED",
      `${message} How to fix: correct the return and submit again; nothing was marked as filed.`,
    );
  }

  const reference = receipt.ackNumber ?? receipt.reference ?? null;
  const finalStage: FilingStage = receipt.ackNumber ? "acknowledged" : "filed";
  const filedAt = Number.isFinite(Date.parse(receipt.submittedAt)) ? new Date(receipt.submittedAt) : new Date();
  const today = filedAt.toISOString().slice(0, 10);

  await prisma.$transaction(async (tx) => {
    await tx.complianceFilingRun.update({
      where: { id: run.id },
      data: {
        stage: finalStage,
        blockedReason: null,
        acknowledgementReference: reference,
        filedAt,
        ...(finalStage === "acknowledged" ? { acknowledgedAt: new Date() } : {}),
        proofBundle: proof as unknown as Prisma.InputJsonValue,
        proofDigest: digest,
        proofCapturedAt: capturedAt,
        updatedById: ctx.user.id,
      },
    });
    await tx.complianceFilingEvent.create({
      data: {
        runId: run.id,
        organizationId: run.organizationId,
        fromStage: from,
        toStage: "filed",
        note: input.note?.trim() || `Submitted via the ${receipt.provider} gateway.`,
        actorId: ctx.user.id,
      },
    });
    if (finalStage === "acknowledged") {
      await tx.complianceFilingEvent.create({
        data: {
          runId: run.id,
          organizationId: run.organizationId,
          fromStage: "filed",
          toStage: "acknowledged",
          note: `Portal acknowledgement ${reference ?? "recorded"}.`,
          actorId: ctx.user.id,
        },
      });
    }
    await tx.clientComplianceStatus.upsert({
      where: { engagementId_taskId: { engagementId: run.engagementId, taskId: run.taskId } },
      create: {
        organizationId: run.organizationId,
        engagementId: run.engagementId,
        taskId: run.taskId,
        status: "filed",
        filedOn: today,
        reference,
        updatedById: ctx.user.id,
      },
      update: { status: "filed", filedOn: today, reference, updatedById: ctx.user.id },
    });
  });

  await logActivity(
    ctx,
    "COMPLIANCE_FILING_SUBMITTED",
    `${run.title} submitted (${receipt.provider}); ${finalStage === "acknowledged" ? `acknowledged ${reference}` : "awaiting acknowledgement"}`,
    null,
    { engagementId: run.engagementId, runId: run.id, provider: receipt.provider, ack: reference },
  );

  const views = await viewRuns(ctx, await loadRuns(run.organizationId, { engagementId: run.engagementId }));
  const match = views.find((candidate) => candidate.id === run.id);
  if (!match) throw new ApiError(500, "INTERNAL", "Filing run could not be read back.");
  return match;
}

/**
 * Move a run one stage forward.
 *
 * Deliberately no "jump to filed": each gate exists because someone with the
 * right role is expected to have looked at the work. A blocked run records why
 * instead of silently stalling.
 */
export async function advanceFilingRun(
  ctx: AuthContext,
  runId: string,
  input: AdvanceFilingInput,
): Promise<FilingRunView> {
  const run = await requireRun(ctx, runId);
  const from = assertStage(run.stage);
  const to = assertStage(input.stage);

  const expected = nextStage(from);
  if (!expected || to !== expected) {
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      expected
        ? `A run at “${from}” can only move to “${expected}”.`
        : "This run is already acknowledged; no further transition exists.",
    );
  }

  const gateRole = STAGE_ROLE[to];
  if (!gateRole) {
    throw new ApiError(409, "INVALID_TRANSITION", "This transition has no role gate.");
  }
  const { role } = await requireEngagementRole(ctx, run.engagementId, gateRole);

  if (to === "prepared" && !run.assigneeId) {
    throw new ApiError(400, "VALIDATION", "Assign the run before marking it prepared.");
  }
  if (to === "reviewed") {
    if (run.assigneeId === ctx.user.id) {
      throw new ApiError(
        403,
        "SEPARATION_OF_DUTIES",
        "The preparer cannot review their own filing. Ask another manager to review it.",
      );
    }
    if (role === "ASSISTANT" || role === "SENIOR") {
      throw new ApiError(403, "FORBIDDEN", "A manager or partner must review this filing.");
    }
  }
  if (to === "acknowledged" && !(input.acknowledgementReference ?? run.acknowledgementReference)) {
    throw new ApiError(400, "VALIDATION", "Record the portal acknowledgement (ARN/SRN) before closing the run.");
  }

  const reference = input.acknowledgementReference?.trim() || run.acknowledgementReference || null;
  const today = new Date().toISOString().slice(0, 10);

  await prisma.$transaction(async (tx) => {
    await tx.complianceFilingRun.update({
      where: { id: run.id },
      data: {
        stage: to,
        updatedById: ctx.user.id,
        ...(to === "reviewed" ? { reviewerId: ctx.user.id } : {}),
        ...(to === "filed" ? { filedAt: new Date() } : {}),
        ...(to === "acknowledged" ? { acknowledgedAt: new Date(), acknowledgementReference: reference } : {}),
      },
    });
    await tx.complianceFilingEvent.create({
      data: {
        runId: run.id,
        organizationId: run.organizationId,
        fromStage: from,
        toStage: to,
        note: input.note?.trim() || null,
        actorId: ctx.user.id,
      },
    });

    // The calendar reads ClientComplianceStatus — write it in the same
    // transaction so a filed run can never sit beside a "pending" obligation.
    if (to === "filed" || to === "acknowledged") {
      await tx.clientComplianceStatus.upsert({
        where: { engagementId_taskId: { engagementId: run.engagementId, taskId: run.taskId } },
        create: {
          organizationId: run.organizationId,
          engagementId: run.engagementId,
          taskId: run.taskId,
          status: "filed",
          filedOn: today,
          reference,
          updatedById: ctx.user.id,
        },
        update: {
          status: "filed",
          filedOn: today,
          reference,
          updatedById: ctx.user.id,
        },
      });
    }
  });

  await logActivity(ctx, "COMPLIANCE_FILING_ADVANCED", `${run.title} moved from ${from} to ${to}`, null, {
    engagementId: run.engagementId,
    runId: run.id,
    from,
    to,
  });

  const view = await viewRuns(ctx, await loadRuns(run.organizationId, { engagementId: run.engagementId }));
  const match = view.find((candidate) => candidate.id === run.id);
  if (!match) throw new ApiError(500, "INTERNAL", "Filing run could not be read back.");
  return match;
}
