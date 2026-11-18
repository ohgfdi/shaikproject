/**
 * Engagement governance — CA practice access, audit-grade change control,
 * working papers, jurisdiction-aware retention, and export/erasure controls.
 *
 * Pure-function cases run with no database. The DB-backed cases reuse the
 * migrated SQLite dev database (global-setup skips the API server for unit
 * suites) and clean up everything they create.
 */
import type { AuthContext } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import {
  applyRetentionPolicy,
  engagementDataPosture,
  executeEngagementErasure,
  exportEngagementPackage,
  planEngagementErasure,
  recordClientConsent,
  requestEngagementErasure,
} from "@/lib/server/data-controls";
import {
  classifySensitiveField,
  engagementRetention,
  engagementPracticeRole,
  orgPrivacySettings,
  practiceRoleLabel,
  practiceRoleToProjectRole,
  requireEngagementAccess,
  canPrepareWork,
  canReview,
  canSignOff,
  canRequestChange,
  canManageAccess,
  redactSensitiveValue,
  redactPayload,
  scrubIdentifiersInText,
  DEFAULT_ORG_PRIVACY,
} from "@/lib/server/engagement";
import {
  createChangeRequest,
  createWorkingPaper,
  completeChangeReview,
  getChangeRequestTimeline,
  implementChangeRequest,
  listEngagementChangeLog,
  reviewWorkingPaper,
  signOffWorkingPaper,
  startReviewChangeRequest,
  submitChangeRequest,
  submitWorkingPaper,
  verifyEngagementLedger,
  workingPaperIndexStatus,
  addWorkingPaperVersion,
} from "@/lib/server/governance";
import { crossBorderTransfer, retentionFloorDays, retentionUntilFor } from "@/lib/server/jurisdiction";
import { createEngagement } from "@/lib/server/organization";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/types";

// ---------------------------------------------------------------------------
// Pure: practice roles
// ---------------------------------------------------------------------------

describe("practice role semantics", () => {
  test("maps to the underlying project role space", () => {
    expect(practiceRoleToProjectRole("PARTNER")).toBe("OWNER");
    expect(practiceRoleToProjectRole("MANAGER")).toBe("EDITOR");
    expect(practiceRoleToProjectRole("REVIEWER")).toBe("EDITOR");
    expect(practiceRoleToProjectRole("SENIOR")).toBe("EDITOR");
    expect(practiceRoleToProjectRole("ASSISTANT")).toBe("EDITOR");
    expect(practiceRoleToProjectRole("AUDITOR")).toBe("AUDITOR");
  });

  test("labels are readable", () => {
    expect(practiceRoleLabel("PARTNER")).toBe("Partner");
    expect(practiceRoleLabel("SENIOR")).toBe("Senior");
    expect(practiceRoleLabel("AUDITOR")).toBe("Auditor (read-only)");
  });

  test("permission helpers match the ladder", () => {
    expect(canPrepareWork("AUDITOR")).toBe(false);
    expect(canPrepareWork("ASSISTANT")).toBe(true);
    expect(canReview("REVIEWER")).toBe(true);
    expect(canReview("SENIOR")).toBe(false);
    expect(canSignOff("PARTNER")).toBe(true);
    expect(canSignOff("MANAGER")).toBe(true);
    expect(canSignOff("SENIOR")).toBe(false);
    expect(canRequestChange("AUDITOR")).toBe(false);
    expect(canManageAccess("PARTNER")).toBe(true);
    expect(canManageAccess("SENIOR")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure: India-CA classification + redaction
// ---------------------------------------------------------------------------

describe("India-CA sensitive data classification and redaction", () => {
  test("classifies common India identifiers by field name", () => {
    expect(classifySensitiveField("PAN")).toBe("pan");
    expect(classifySensitiveField("GSTIN")).toBe("gstin");
    expect(classifySensitiveField("CIN")).toBe("cin");
    expect(classifySensitiveField("DIN")).toBe("din");
    expect(classifySensitiveField("TAN")).toBe("tan");
    expect(classifySensitiveField("AADHAAR")).toBe("aadhaar_partial");
    expect(classifySensitiveField("BANK_ACCOUNT")).toBe("bank_account_partial");
    expect(classifySensitiveField("accountNumber")).toBe("bank_account_partial");
    expect(classifySensitiveField("clientName")).toBe("taxpayer_name");
    expect(classifySensitiveField("narration")).toBe("else");
  });

  test("redacts identifiers to their last four characters", () => {
    expect(redactSensitiveValue("pan", "ABCDE1234F", false)).toBe("PAN •••• 234F");
    expect(redactSensitiveValue("pan", "ABCDE1234F", true)).toBe("ABCDE1234F");
    expect(redactSensitiveValue("gstin", "27AAABC1234A1Z5", false)).toBe("GSTIN •••• A1Z5");
    expect(redactSensitiveValue("aadhaar_partial", "1234567890", false)).toBe("•••• 7890");
    expect(redactSensitiveValue("taxpayer_name", "Acme Industries", false)).toMatch(/^Client ••• \(X-/);
    expect(redactSensitiveValue("taxpayer_name", "Acme Industries", true)).toBe("Acme Industries");
  });

  test("redactPayload masks sensitive fields and keeps the rest", () => {
    const payload = {
      PAN: "ABCDE1234F",
      GSTIN: "27AAABC1234A1Z5",
      taxableValue: 100000,
      notes: "no sensitive data here",
    };
    const redacted = redactPayload(payload, false) as Record<string, unknown>;
    expect(redacted.PAN).toBe("PAN •••• 234F");
    expect(redacted.GSTIN).toBe("GSTIN •••• A1Z5");
    expect(redacted.taxableValue).toBe(100000);
    expect(redacted.notes).toBe("no sensitive data here");
  });

  test("scrubIdentifiersInText removes identifiers typed into free text", () => {
    const text = "Client PAN ABCDE1234F and GSTIN 27AAABC1234A1Z5 reviewed";
    const scrubbed = scrubIdentifiersInText(text);
    expect(scrubbed).not.toContain("ABCDE1234F");
    expect(scrubbed).not.toContain("27AAABC1234A1Z5");
    expect(scrubbed).toContain("PAN •••• 234F");
  });
});

// ---------------------------------------------------------------------------
// Pure: jurisdiction-aware handling
// ---------------------------------------------------------------------------

describe("jurisdiction-aware handling", () => {
  test("India is the default and unknown codes fail safe", () => {
    const inFloor = retentionFloorDays("IN");
    expect(inFloor).toBeGreaterThanOrEqual(8 * 365);
    // An unregistered code falls back to the strictest known floor.
    expect(retentionFloorDays("ZZ")).toBe(inFloor);
  });

  test("retentionUntilFor never goes below the statutory floor", () => {
    const from = new Date("2026-04-01T00:00:00.000Z");
    const floored = retentionUntilFor("IN", from, { overrideDays: 10 });
    expect(floored.getTime()).toBeGreaterThan(from.getTime() + 365 * 24 * 3600 * 1000);
    const extended = retentionUntilFor("IN", from, { overrideDays: 3650 });
    expect(extended.getTime()).toBeGreaterThan(floored.getTime());
  });

  test("cross-border transfer requires consent", () => {
    expect(crossBorderTransfer("IN", "IN")).toEqual({ crossBorder: false, consentRequired: false });
    expect(crossBorderTransfer("IN", "US")).toEqual({ crossBorder: true, consentRequired: true });
    expect(crossBorderTransfer("IN", "")).toEqual({ crossBorder: false, consentRequired: false });
  });

  test("engagementRetention honours a legal hold", () => {
    const privacy = { ...DEFAULT_ORG_PRIVACY };
    const held = engagementRetention(
      {
        jurisdiction: "IN",
        legalHold: true,
        retentionUntil: null,
        dataClassification: "RESTRICTED",
        createdAt: new Date("2020-01-01"),
      },
      privacy,
      new Date("2035-01-01"),
    );
    expect(held.legalHold).toBe(true);
    expect(held.purgeEligible).toBe(false);

    const free = engagementRetention(
      {
        jurisdiction: "IN",
        legalHold: false,
        retentionUntil: null,
        dataClassification: "CONFIDENTIAL",
        createdAt: new Date("2010-01-01"),
      },
      privacy,
      new Date("2035-01-01"),
    );
    expect(free.purgeEligible).toBe(true);
    expect(free.statutoryBases.length).toBeGreaterThan(0);
  });

  test("orgPrivacySettings fills safe defaults", () => {
    const parsed = orgPrivacySettings(null).privacy;
    expect(parsed.panRedactionDefault).toBe(true);
    expect(parsed.taxpayerExportConsentRequired).toBe(true);
    expect(parsed.crossBorderTransferAllowed).toBe(false);
    const merged = orgPrivacySettings(JSON.stringify({ privacy: { crossBorderTransferAllowed: true } })).privacy;
    expect(merged.crossBorderTransferAllowed).toBe(true);
    expect(merged.panRedactionDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB-backed
// ---------------------------------------------------------------------------

const TEST_PREFIX = `eng_gov_${Date.now()}_`;

describe("engagement governance (DB)", () => {
  let userA = ""; // OWNER  → PARTNER
  let userB = ""; // MEMBER → ASSISTANT
  let userC = ""; // ADMIN  → MANAGER
  let userOut = ""; // no firm
  let orgId = "";
  let engagementId = "";
  let projectId = "";

  async function ctxFor(userId: string): Promise<AuthContext> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const membership = await prisma.organizationMember.findFirst({
      where: { userId },
      include: { organization: true },
    });
    return {
      user,
      workspace: { id: user.workspaceId!, name: `${user.id} WS` },
      settings: DEFAULT_WORKSPACE_SETTINGS,
      organization: membership?.organization ?? null,
      organizationRole: membership?.role ?? null,
      isAdmin: user.isAdmin,
    };
  }

  beforeAll(async () => {
    userA = `${TEST_PREFIX}a`;
    userB = `${TEST_PREFIX}b`;
    userC = `${TEST_PREFIX}c`;
    userOut = `${TEST_PREFIX}out`;
    for (const [id, name] of [
      [userA, "Partner A"],
      [userB, "Assistant B"],
      [userC, "Manager C"],
      [userOut, "Outsider"],
    ] as const) {
      await prisma.user.create({
        data: { id, email: `${id}@test.com`, name, passwordHash: "x", workspaceId: `${id}WS` },
      });
    }

    const org = await prisma.organization.create({
      data: {
        name: "Governance Test Firm",
        members: {
          create: [
            { userId: userA, role: "OWNER" },
            { userId: userB, role: "MEMBER" },
            { userId: userC, role: "ADMIN" },
          ],
        },
      },
    });
    orgId = org.id;

    const result = await createEngagement(await ctxFor(userA), { name: "Acme FY26", code: "ACME-FY26" });
    engagementId = result.engagement.id;
    projectId = result.projectId!;
  });

  afterAll(async () => {
    await prisma.workingPaperVersion.deleteMany({ where: { workingPaper: { engagementId } } });
    await prisma.workingPaper.deleteMany({ where: { engagementId } });
    await prisma.engagementChangeLog.deleteMany({ where: { engagementId } });
    await prisma.engagementChangeRequest.deleteMany({ where: { engagementId } });
    await prisma.clientConsent.deleteMany({ where: { engagementId } });
    await prisma.engagementMember.deleteMany({ where: { engagementId } });
    await prisma.projectMember.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { engagementId } });
    await prisma.engagement.deleteMany({ where: { id: engagementId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.workspace.deleteMany({ where: { id: { in: [userA, userB, userC, userOut].map((id) => id + "WS") } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB, userC, userOut] } } });
  });

  test("firm roles map to practice roles on the engagement", async () => {
    const engagement = { id: engagementId, organizationId: orgId };
    const project = { id: projectId, ownerId: userA, workspaceId: (await ctxFor(userA)).workspace.id };
    expect(await engagementPracticeRole(await ctxFor(userA), engagement, project)).toBe("PARTNER");
    expect(await engagementPracticeRole(await ctxFor(userB), engagement, project)).toBe("ASSISTANT");
    expect(await engagementPracticeRole(await ctxFor(userC), engagement, project)).toBe("MANAGER");
  });

  test("an explicit engagement assignment overrides the firm role", async () => {
    const ctx = await ctxFor(userA);
    const { grantEngagementAccess } = await import("@/lib/server/engagement");
    await grantEngagementAccess(ctx, engagementId, { userId: userB, practiceRole: "SENIOR" });

    const engagement = { id: engagementId, organizationId: orgId };
    const project = { id: projectId, ownerId: userA, workspaceId: ctx.workspace.id };
    expect(await engagementPracticeRole(await ctxFor(userB), engagement, project)).toBe("SENIOR");

    await expect(requireEngagementAccess(await ctxFor(userB), engagement, project, "SENIOR")).resolves.toBe("SENIOR");
  });

  test("an outsider cannot access the engagement", async () => {
    const ctx = await ctxFor(userOut);
    await expect(
      requireEngagementAccess(
        ctx,
        { id: engagementId, organizationId: orgId },
        { id: projectId, ownerId: userA, workspaceId: "x" },
        "ASSISTANT",
      ),
    ).rejects.toThrow();
  });

  test("change request lifecycle records review and sign-off in an intact ledger", async () => {
    const assistant = await ctxFor(userB);
    const partner = await ctxFor(userA);

    const cr = await createChangeRequest(assistant, engagementId, {
      title: "Correct GSTIN on client master",
      description: "Transposed characters in the GSTIN.",
      rationale: "The GSTIN on the client master does not match the registration certificate.",
      targetType: "clientMaster",
    });
    expect(cr.state).toBe("DRAFT");

    // The ledger already records creation.
    const ledger = await listEngagementChangeLog(orgId, engagementId);
    expect(ledger.some((e) => e.action === "CHANGE_REQUEST_CREATED")).toBe(true);

    await expect(completeChangeReview(partner, engagementId, cr.id, "approve", null)).rejects.toThrow(); // cannot approve before review

    const submitted = await submitChangeRequest(assistant, engagementId, cr.id);
    expect(submitted.state).toBe("REQUESTED");

    const inReview = await startReviewChangeRequest(partner, engagementId, cr.id);
    expect(inReview.state).toBe("IN_REVIEW");

    const approved = await completeChangeReview(partner, engagementId, cr.id, "approve", "GSTIN verified.");
    expect(approved.state).toBe("APPROVED");

    const implemented = await implementChangeRequest(assistant, engagementId, cr.id);
    expect(implemented.state).toBe("IMPLEMENTED");

    const { timeline } = await getChangeRequestTimeline(partner, engagementId, cr.id);
    const actions = timeline.map((t) => t.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "CHANGE_REQUEST_CREATED",
        "CHANGE_REQUEST_SUBMITTED",
        "CHANGE_REQUEST_REVIEW_STARTED",
        "CHANGE_REQUEST_APPROVED",
        "CHANGE_REQUEST_IMPLEMENTED",
      ]),
    );
    const approval = timeline.find((t) => t.action === "CHANGE_REQUEST_APPROVED");
    expect(approval?.actorPracticeRole).toBe("PARTNER");
    expect(approval?.meta?.reviewNote).toBe("GSTIN verified.");

    const verification = await verifyEngagementLedger(orgId, engagementId);
    expect(verification.valid).toBe(true);
    expect(verification.entries).toBeGreaterThanOrEqual(5);
  });

  test("submit requires a recorded reason (the why)", async () => {
    const assistant = await ctxFor(userB);
    const cr = await createChangeRequest(assistant, engagementId, {
      title: "Adjust opening balance",
      targetType: "book",
    });
    await expect(submitChangeRequest(assistant, engagementId, cr.id)).rejects.toThrow();
  });

  test("working paper lifecycle: version, review, sign-off, binder index", async () => {
    const manager = await ctxFor(userC);
    const partner = await ctxFor(userA);

    const wp = await createWorkingPaper(manager, engagementId, {
      indexRef: "B-200",
      title: "Substantive testing of trade receivables",
      saReference: "SA 500",
      content: { sampleSize: 40, exceptions: 1 },
    });
    expect(wp.version).toBe(1);
    expect(wp.status).toBe("DRAFT");

    const revised = await addWorkingPaperVersion(manager, engagementId, wp.id, {
      content: { sampleSize: 45, exceptions: 0 },
      changeSummary: "Expanded sample to 45 and cleared the exception.",
    });
    expect(revised.version).toBe(2);

    await submitWorkingPaper(manager, engagementId, wp.id);

    // The preparer cannot review their own paper.
    await expect(reviewWorkingPaper(manager, engagementId, wp.id, { approved: true })).rejects.toThrow();

    const reviewed = await reviewWorkingPaper(partner, engagementId, wp.id, {
      approved: true,
      note: "Evidence sufficient.",
    });
    expect(reviewed.status).toBe("REVIEWED");
    expect(reviewed.reviewedById).toBe(userA);

    // The preparer cannot sign off their own paper (manager, not partner).
    await expect(signOffWorkingPaper(manager, engagementId, wp.id)).rejects.toThrow();

    const signed = await signOffWorkingPaper(partner, engagementId, wp.id, "Signed off.");
    expect(signed.status).toBe("SIGNED_OFF");
    expect(signed.signOffRole).toBe("PARTNER");
    expect(signed.signedOffById).toBe(userA);

    const index = await workingPaperIndexStatus(partner, engagementId);
    expect(index.entries.find((e) => e.ref === "B-200")?.status).toBe("signed-off");
    expect(index.complete).toBe(false); // other statutory refs are still missing
  });

  test("AUDITOR cannot prepare, export or raise changes", async () => {
    const { grantEngagementAccess } = await import("@/lib/server/engagement");
    await grantEngagementAccess(await ctxFor(userA), engagementId, { userId: userB, practiceRole: "AUDITOR" });
    const auditor = await ctxFor(userB);
    await expect(
      createChangeRequest(auditor, engagementId, { title: "Nope", targetType: "clientData" }),
    ).rejects.toThrow();
    await expect(exportEngagementPackage(auditor, engagementId, { reason: "Reading only" })).rejects.toThrow();
    // restore assistant for later tests
    await grantEngagementAccess(await ctxFor(userA), engagementId, { userId: userB, practiceRole: "SENIOR" });
  });

  test("export is blocked without consent, then allowed and redacted", async () => {
    const partner = await ctxFor(userA);

    await expect(
      exportEngagementPackage(partner, engagementId, { reason: "Client requested the file" }),
    ).rejects.toThrow(/consent/i);

    await recordClientConsent(partner, engagementId, {
      purpose: "statutory-filing",
      subjectRef: "Client CFO",
      evidenceNote: "Signed engagement-letter consent.",
    });

    const pkg = await exportEngagementPackage(partner, engagementId, { reason: "Client requested the file" });
    expect(pkg.scope.redacted).toBe(true);
    expect(pkg.counts).toHaveProperty("workingPaper");

    const verification = await verifyEngagementLedger(orgId, engagementId);
    expect(verification.valid).toBe(true);
    const ledger = await listEngagementChangeLog(orgId, engagementId);
    expect(ledger.some((e) => e.action === "ENGAGEMENT_EXPORTED")).toBe(true);
  });

  test("erasure is blocked by a legal hold and by an active retention floor", async () => {
    const partner = await ctxFor(userA);

    await applyRetentionPolicy(partner, engagementId, { legalHold: true, reason: "Ongoing assessment proceeding." });
    let plan = await planEngagementErasure(partner, engagementId);
    expect(plan.eligible).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/legal hold/i);

    await applyRetentionPolicy(partner, engagementId, {
      legalHold: false,
      retentionUntil: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 20).toISOString(),
      reason: "Hold released; statutory retention continues.",
    });
    plan = await planEngagementErasure(partner, engagementId);
    expect(plan.eligible).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/retention/i);

    const requested = await requestEngagementErasure(
      partner,
      engagementId,
      "Client disengaged; data to be returned and removed.",
    );
    expect(requested.requested).toBe(true);
  });

  test("erasure executes only with an explicit override, retaining audit proof", async () => {
    const partner = await ctxFor(userA);

    const { archived, erased, retained } = await executeEngagementErasure(partner, engagementId, {
      reason: "Client disengaged; partner authorises early erasure.",
      confirm: "ACME-FY26",
      overrideRetention: true,
    });
    expect(archived).toBe(true);
    expect(retained).toEqual(expect.arrayContaining(["changeLog", "clientConsent"]));
    expect(erased.workingPapers).toBeGreaterThanOrEqual(0);

    // The ledger and consent proof survive the erasure.
    const verification = await verifyEngagementLedger(orgId, engagementId);
    expect(verification.valid).toBe(true);
    const logs = await listEngagementChangeLog(orgId, engagementId);
    expect(logs.some((e) => e.action === "ERASURE_EXECUTED")).toBe(true);
    expect(await prisma.clientConsent.count({ where: { engagementId } })).toBeGreaterThan(0);

    const posture = await engagementDataPosture(partner, engagementId);
    expect(posture.counts.workingPaper).toBe(0);
  });

  test("the ledger is tamper-evident: an edited row breaks verification", async () => {
    const first = await prisma.engagementChangeLog.findFirst({
      where: { engagementId },
      orderBy: { seq: "asc" },
    });
    expect(first).toBeTruthy();
    await prisma.engagementChangeLog.update({ where: { id: first!.id }, data: { summary: "tampered summary" } });

    const verification = await verifyEngagementLedger(orgId, engagementId);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtSeq).toBe(first!.seq);
  });
});
