/**
 * Practice management — firm-wide operating system engine, oracle tests.
 *
 * The engine speaks MAJOR UNITS (INR rupees) for fee/time figures and ISO dates
 * for everything date-shaped. Money that other engines treat as paise is NOT
 * converted here — that conversion belongs in the API adapter, which mirrors the
 * payroll-operations pattern. These tests pin the engine's own contract.
 */

import {
  buildPracticeWorkspace,
  type EngagementConfig,
  type ClientConfig,
  type EngagementDeadlineConfig,
  type DocumentConfig,
  type PracticeAccessRole,
  type FirmAnalyticsResult,
  applyReassignment,
  roleMayAccess,
  documentsPastRetention,
  clientAccessSummary,
  assignmentReviewStatus,
} from "@/lib/engine/ca-practice-management";

const FIRM = {
  firmId: "FIRM-001",
  name: "Ledgerly CA Partners",
  calendarWindowStart: "2025-04-01",
  calendarWindowEnd: "2025-06-30",
};

const CLIENT_A: ClientConfig = {
  clientId: "CLIENT-A",
  name: "Acme Industries Ltd",
  identifiers: { cin: "U74999DL2010PLC057890", gstin: "27AAAAA0000A1Z00" },
  workpaperTemplateIds: ["TMP-ACA-GST", "TMP-ACA-ITR"],
  primaryContact: "Anil Kumar",
  allowedRoles: ["partner", "reviewer", "assistant"] as PracticeAccessRole[],
};

const CLIENT_B: ClientConfig = {
  clientId: "CLIENT-B",
  name: "Beta Retail Pvt Ltd",
  identifiers: { cin: "U45678MH2015PLC123456" },
  workpaperTemplateIds: ["TMP-BTR-PF"],
  primaryContact: "Sara Vale",
  allowedRoles: ["partner", "reviewer"] as PracticeAccessRole[],
};

function engagement(
  engagementId: string,
  clientId: string,
  matter: string,
  status: EngagementConfig["status"],
  over: Partial<EngagementConfig> = {},
): EngagementConfig {
  return {
    engagementId,
    clientId,
    matter,
    status,
    scope: `Statutory audit of ${matter}`,
    periodLabel: "2024-25",
    leadPartner: "P001",
    reviewers: ["R001"],
    feeBudget: 500_000,
    feeBilled: 400_000,
    feeRealised: 300_000,
    timeRecordedHours: 120,
    communications: [
      { date: "2025-05-01", from: "P001", to: "Anil Kumar", subject: "Engagement letter", note: "Signed" },
      { date: "2025-05-10", from: "R001", to: "Anil Kumar", subject: "Draft report", note: "replied" },
    ],
    phases: [
      {
        phaseId: "P1",
        name: "Planning",
        budgetHours: 20,
        actualHours: 18,
        feeBudget: 100_000,
        feeBilled: 80_000,
        status: "completed",
      },
      {
        phaseId: "P2",
        name: "Fieldwork",
        budgetHours: 80,
        actualHours: 90,
        feeBudget: 300_000,
        feeBilled: 240_000,
        status: "in-progress",
      },
    ],
    deadlines: [
      {
        deadlineId: "D1",
        label: "Draft report to client",
        dueDate: "2025-06-15",
        entityTag: null,
        dependsOn: [],
        status: "upcoming",
        owner: "R001",
      },
      {
        deadlineId: "D2",
        label: "Final report signing",
        dueDate: "2025-06-30",
        entityTag: null,
        dependsOn: ["D1"],
        status: "upcoming",
        owner: "P001",
      },
    ],
    workpapers: [
      {
        workpaperId: "WP1",
        workpaperNumber: "WP-2025-0417",
        title: "Cash reconciliation",
        familyId: "FAM-CASH",
        templateId: "TMP-ACA-GST",
        status: "draft",
        ownerType: "assistant",
        ownerUserId: "A001",
        crossReferences: [],
        dueDate: "2025-06-10",
        reviewHistory: [],
      },
      {
        workpaperId: "WP2",
        workpaperNumber: "WP-2025-0418",
        title: "Receivables confirmation",
        familyId: "FAM-AR",
        templateId: "TMP-ACA-ITR",
        status: "in-review",
        ownerType: "reviewer",
        ownerUserId: "R001",
        crossReferences: ["WP-2025-0417"],
        dueDate: "2025-06-15",
        reviewHistory: [{ date: "2025-06-01", action: "submitted-for-review", byUserId: "A001" }],
      },
    ],
    documents: [
      {
        documentId: "DOC1",
        name: "Engagement letter",
        type: "engagement-letter",
        version: 1,
        documentClass: "supporting",
        uploadedAt: "2025-05-01",
        ownerUserId: "P001",
        status: "final",
        retentionUntil: "2030-05-01",
        allowedRoles: ["partner"] as PracticeAccessRole[],
      },
      {
        documentId: "DOC2",
        name: "Draft audit report",
        type: "audit-report",
        version: 2,
        documentClass: "final-report",
        uploadedAt: "2025-06-01",
        ownerUserId: "R001",
        status: "final",
        retentionUntil: "2030-06-01",
        allowedRoles: ["partner", "reviewer"] as PracticeAccessRole[],
      },
    ],
    ...over,
  };
}

const BASE = {
  firm: FIRM,
  clients: [CLIENT_A, CLIENT_B],
  engagements: [
    engagement("E1", "CLIENT-A", "Acme Industries Ltd", "in-progress"),
    engagement("E2", "CLIENT-B", "Beta Retail Pvt Ltd", "under-review", {
      feeBudget: 300_000,
      feeBilled: 250_000,
      feeRealised: 200_000,
      timeRecordedHours: 80,
      phases: [
        {
          phaseId: "P1",
          name: "Planning",
          budgetHours: 10,
          actualHours: 10,
          feeBudget: 50_000,
          feeBilled: 40_000,
          status: "completed",
        },
        {
          phaseId: "P2",
          name: "Fieldwork",
          budgetHours: 60,
          actualHours: 55,
          feeBudget: 200_000,
          feeBilled: 160_000,
          status: "in-progress",
        },
      ],
      deadlines: [
        {
          deadlineId: "D1",
          label: "Stock count attendance",
          dueDate: "2025-05-20",
          entityTag: "entity-1",
          dependsOn: [],
          status: "overdue",
          owner: "R001",
        },
        {
          deadlineId: "D2",
          label: "Surprise check completion",
          dueDate: "2025-06-01",
          entityTag: "entity-1",
          dependsOn: ["D1"],
          status: "upcoming",
          owner: "P001",
        },
      ],
      workpapers: [
        {
          workpaperId: "WP1",
          workpaperNumber: "WP-2025-0501",
          title: "Stock count sheet",
          familyId: "FAM-STOCK",
          templateId: "TMP-BTR-PF",
          status: "in-review",
          ownerType: "reviewer",
          ownerUserId: "R001",
          crossReferences: [],
          dueDate: "2025-05-25",
          reviewHistory: [],
        },
      ],
      documents: [
        {
          documentId: "DOC1",
          name: "Stock count report",
          type: "stock-report",
          version: 1,
          documentClass: "working-paper",
          uploadedAt: "2025-05-20",
          ownerUserId: "A001",
          status: "draft",
          retentionUntil: "2027-05-20",
          allowedRoles: ["partner", "assistant"] as PracticeAccessRole[],
        },
      ],
      // Explicitly clear the helper's default comms so the "no comms → 0 pending"
      // assertion below is about this engagement, not the shared default.
      communications: [],
    }),
  ],
  analytics: {
    realisation: true,
    pipeline: true,
    overdue: true,
    complianceDueList: true,
    staffingLoad: true,
  } as FirmAnalyticsResult["realisation"] extends object
    ? {
        realisation: boolean;
        pipeline: boolean;
        overdue: boolean;
        complianceDueList: boolean;
        staffingLoad: boolean;
      }
    : never,
};

describe("firm-wide practice management — engagement lifecycle", () => {
  it("returns firm, client and engagement summaries", () => {
    const res = buildPracticeWorkspace(BASE);
    expect(res.firm).toEqual({ firmId: "FIRM-001", name: "Ledgerly CA Partners", clientCount: 2, engagementCount: 2 });
    expect(res.clients).toHaveLength(2);
    expect(res.clients.find((c) => c.clientId === "CLIENT-A")!.name).toBe("Acme Industries Ltd");
    expect(res.engagements).toHaveLength(2);
    expect(res.engagements.find((e) => e.engagementId === "E1")!.matter).toBe("Acme Industries Ltd");
  });

  it("computes engagement-level realisation and time-budget variance", () => {
    const res = buildPracticeWorkspace(BASE);
    const e1 = res.engagements.find((e) => e.engagementId === "E1")!;
    // feeBudget 500k, feeRealised 300k → realisation 60%
    expect(e1.realisationPct).toBe(60);
    expect(e1.feeBudget).toBe(500_000);
    expect(e1.feeBilled).toBe(400_000);
    expect(e1.feeRealised).toBe(300_000);
    expect(e1.timeRecordedHours).toBe(120);
    // P1 20→18, P2 80→90 ⇒ total 100→108 ⇒ variance +8%
    expect(e1.timeBudgetVariancePct).toBeCloseTo(8, 2);
    expect(e1.phaseBreakdown).toHaveLength(2);
    expect(e1.phaseBreakdown.find((p) => p.phaseId === "P2")!.hoursVariancePct).toBeCloseTo(12.5, 2);
    expect(e1.phaseBreakdown.find((p) => p.phaseId === "P2")!.feeVariancePct).toBeCloseTo(-20, 2);
  });

  it("flags engagements that are over their time budget", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E3", "CLIENT-A", "Over-budget engagement", "in-progress", {
          feeBudget: 100_000,
          feeBilled: 50_000,
          // Realised above billed so BOTH warnings under test fire.
          feeRealised: 60_000,
          timeRecordedHours: 200,
          phases: [
            {
              phaseId: "P1",
              name: "Fieldwork",
              budgetHours: 50,
              actualHours: 200,
              feeBudget: 100_000,
              feeBilled: 50_000,
              status: "in-progress",
            },
          ],
          deadlines: [],
          workpapers: [],
          documents: [],
        }),
      ],
    });
    const e = res.engagements[0]!;
    expect(e.warnings).toContainEqual(expect.stringMatching(/over its time budget/));
    expect(e.warnings).toContainEqual(expect.stringMatching(/realised more than billed/));
  });

  it("counts pending client communications correctly", () => {
    const res = buildPracticeWorkspace(BASE);
    const e1 = res.engagements.find((e) => e.engagementId === "E1")!;
    // 2 comms; one has note "replied" → pending = 1
    expect(e1.pendingCommunications).toBe(1);
    const e2 = res.engagements.find((e) => e.engagementId === "E2")!;
    // 0 comms set → 0 pending
    expect(e2.pendingCommunications).toBe(0);
  });

  it("counts open workpapers and unsigned documents per engagement", () => {
    const res = buildPracticeWorkspace(BASE);
    const e1 = res.engagements.find((e) => e.engagementId === "E1")!;
    // WP1 draft + WP2 in-review → 2 open (neither signed-off)
    expect(e1.openWorkpaperCount).toBe(2);
    // DOC2 final-report, status final (not signed) → unsigned
    expect(e1.unsignedDocumentCount).toBe(1);
    const e2 = res.engagements.find((e) => e.engagementId === "E2")!;
    // DOC1 working-paper draft → not unsigned (working-paper class)
    expect(e2.unsignedDocumentCount).toBe(0);
  });

  it("supports engagement status lifecycle across statuses", () => {
    const statuses: EngagementConfig["status"][] = [
      "entered",
      "scoped",
      "in-progress",
      "under-review",
      "completed",
      "archived",
    ];
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: statuses.map((s, i) =>
        engagement(`E-${i}`, "CLIENT-A", `Matter ${i}`, s, {
          deadlines: [],
          workpapers: [],
          documents: [],
          phases: [],
        }),
      ),
      analytics: { realisation: false, pipeline: true, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.engagements.map((e) => e.status)).toEqual(statuses);
    // Pipeline roll-up counts by status
    expect(res.firmAnalytics.pipeline.byStatus.find((b) => b.status === "scoped")!.count).toBe(1);
    expect(res.firmAnalytics.pipeline.byStatus.find((b) => b.status === "under-review")!.count).toBe(1);
    expect(res.firmAnalytics.pipeline.inScopeCount).toBe(1);
    expect(res.firmAnalytics.pipeline.inProgressCount).toBe(2);
    expect(res.firmAnalytics.pipeline.underReviewCount).toBe(1);
  });
});

describe("firm-wide practice management — workpaper system", () => {
  it("validates workpaper numbering and cross-references", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          workpapers: [
            {
              workpaperId: "WP1",
              workpaperNumber: "WP-2025-0001",
              title: "Cash recon",
              familyId: "FAM-CASH",
              templateId: "TMP-ACA-GST",
              status: "draft",
              ownerType: "assistant",
              ownerUserId: "A001",
              crossReferences: ["WP-2025-0002"],
              dueDate: "2025-06-10",
              reviewHistory: [],
            },
            {
              workpaperId: "WP2",
              workpaperNumber: "WP-2025-0002",
              title: "Receivables",
              familyId: "FAM-AR",
              templateId: "TMP-ACA-ITR",
              status: "in-review",
              ownerType: "reviewer",
              ownerUserId: "R001",
              crossReferences: [],
              dueDate: "2025-06-15",
              reviewHistory: [],
            },
          ],
          deadlines: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.warnings).not.toContainEqual(expect.stringMatching(/references unknown workpaper/));
    expect(res.engagements[0]!.warnings).not.toContainEqual(expect.stringMatching(/references unknown workpaper/));
  });

  it("flags cross-references to unknown workpaper numbers", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          workpapers: [
            {
              workpaperId: "WP1",
              workpaperNumber: "WP-2025-0001",
              title: "Cash recon",
              familyId: "FAM-CASH",
              templateId: "TMP-ACA-GST",
              status: "draft",
              ownerType: "assistant",
              ownerUserId: "A001",
              crossReferences: ["WP-2025-9999"],
              dueDate: "2025-06-10",
              reviewHistory: [],
            },
          ],
          deadlines: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.warnings).toContainEqual(expect.stringMatching(/references unknown workpaper WP-2025-9999/));
  });

  it("supports reusable working-paper families and client-specific templates", () => {
    const res = buildPracticeWorkspace(BASE);
    const wp = res.engagements.find((e) => e.engagementId === "E1")!.workpapers[0]!;
    expect(wp.workpaperNumber).toBe("WP-2025-0417");
    expect(wp.familyId).toBe("FAM-CASH");
    expect(wp.templateId).toBe("TMP-ACA-GST");
  });

  it("tracks review/rework/sign-off history on a workpaper", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          workpapers: [
            {
              workpaperId: "WP1",
              workpaperNumber: "WP-2025-0010",
              title: "Final review",
              familyId: "FAM-FINAL",
              templateId: "TMP-ACA-ITR",
              status: "approved",
              ownerType: "partner",
              ownerUserId: "P001",
              crossReferences: [],
              dueDate: "2025-06-30",
              reviewHistory: [
                { date: "2025-06-01", action: "submitted-for-review", byUserId: "A001" },
                { date: "2025-06-05", action: "review-note", byUserId: "R001", note: "Check cut-off" },
                { date: "2025-06-10", action: "approved", byUserId: "P001" },
                { date: "2025-06-15", action: "signed-off", byUserId: "P001" },
              ],
            },
          ],
          deadlines: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    const wp = res.engagements[0]!.workpapers[0]!;
    expect(wp.status).toBe("approved");
    expect(wp.reviewHistory).toHaveLength(4);
    expect(wp.reviewHistory.map((r) => r.action)).toEqual([
      "submitted-for-review",
      "review-note",
      "approved",
      "signed-off",
    ]);
  });

  it("counts open workpapers only when status is not signed-off", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          workpapers: [
            {
              workpaperId: "WP1",
              workpaperNumber: "WP-2025-0020",
              title: "Approved",
              familyId: "FAM-FINAL",
              templateId: "TMP-ACA-ITR",
              status: "approved",
              ownerType: "partner",
              ownerUserId: "P001",
              crossReferences: [],
              dueDate: "2025-06-30",
              reviewHistory: [],
            },
            {
              workpaperId: "WP2",
              workpaperNumber: "WP-2025-0021",
              title: "Signed off",
              familyId: "FAM-FINAL",
              templateId: "TMP-ACA-ITR",
              status: "signed-off",
              ownerType: "partner",
              ownerUserId: "P001",
              crossReferences: [],
              dueDate: "2025-06-30",
              reviewHistory: [],
            },
          ],
          deadlines: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.engagements[0]!.openWorkpaperCount).toBe(1);
  });
});

describe("firm-wide practice management — deadline management", () => {
  it("computes client/entity-scoped deadline status against the firm-wide calendar", () => {
    const res = buildPracticeWorkspace(BASE);
    const e2 = res.engagements.find((e) => e.engagementId === "E2")!;
    // D1 due 2025-05-20, window end 2025-06-30 → overdue
    expect(e2.deadlines.find((d) => d.deadlineId === "D1")!.status).toBe("overdue");
    // D2 due 2025-06-01, window end 2025-06-30 → overdue as well (in the past)
    expect(e2.deadlines.find((d) => d.deadlineId === "D2")!.status).toBe("overdue");
    const e1 = res.engagements.find((e) => e.engagementId === "E1")!;
    // D1 due 2025-06-15, window end 2025-06-30 → upcoming
    expect(e1.deadlines.find((d) => d.deadlineId === "D1")!.status).toBe("upcoming");
  });

  it("supports entity tags on deadlines", () => {
    const res = buildPracticeWorkspace(BASE);
    const e2 = res.engagements.find((e) => e.engagementId === "E2")!;
    const d1 = e2.deadlines.find((d) => d.deadlineId === "D1")!;
    expect(d1.entityTag).toBe("entity-1");
  });

  it("detects dependency cycles and reports them", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          deadlines: [
            {
              deadlineId: "D1",
              label: "First",
              dueDate: "2025-06-10",
              entityTag: null,
              dependsOn: ["D2"],
              status: "upcoming",
              owner: "R001",
            },
            {
              deadlineId: "D2",
              label: "Second",
              dueDate: "2025-06-15",
              entityTag: null,
              dependsOn: ["D1"],
              status: "upcoming",
              owner: "P001",
            },
          ],
          workpapers: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.warnings).toContainEqual(expect.stringMatching(/dependency cycle/));
  });

  it("computes dependent counts for a deadline", () => {
    const res = buildPracticeWorkspace(BASE);
    const e1 = res.engagements.find((e) => e.engagementId === "E1")!;
    const d2 = e1.deadlines.find((d) => d.deadlineId === "D2")!;
    // D2 is depended on by nothing else → 0
    expect(d2.dependentCount).toBe(0);
    // Add a third deadline that depends on D2
    const res2 = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          deadlines: [
            {
              deadlineId: "D1",
              label: "Draft report",
              dueDate: "2025-06-15",
              entityTag: null,
              dependsOn: [],
              status: "upcoming",
              owner: "R001",
            },
            {
              deadlineId: "D2",
              label: "Final signing",
              dueDate: "2025-06-30",
              entityTag: null,
              dependsOn: ["D1"],
              status: "upcoming",
              owner: "P001",
            },
            {
              deadlineId: "D3",
              label: "ROC filing",
              dueDate: "2025-07-31",
              entityTag: "entity-1",
              dependsOn: ["D2"],
              status: "upcoming",
              owner: "R001",
            },
          ],
          workpapers: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    const d2b = res2.engagements[0]!.deadlines.find((d) => d.deadlineId === "D2")!;
    expect(d2b.dependentCount).toBe(1);
  });

  it("computes the firm-wide compliance calendar and due list across all clients", () => {
    const res = buildPracticeWorkspace(BASE);
    expect(res.firmAnalytics.complianceDueList).toHaveLength(2);
    // E2 D1 overdue, E2 D2 overdue, E1 D1 upcoming, E1 D2 upcoming
    expect(res.firmAnalytics.overdueWork.overdueDeadlineCount).toBeGreaterThanOrEqual(2);
    const dueList = res.firmAnalytics.complianceDueList;
    expect(dueList.map((d) => d.clientName)).toContain("Beta Retail Pvt Ltd");
    expect(dueList.map((d) => d.engagementMatter)).toContain("Beta Retail Pvt Ltd");
    expect(dueList.every((d) => d.status === "due" || d.status === "overdue")).toBe(true);
  });

  it("supports deadline reassignment with reason and escalation", () => {
    const deadline: EngagementDeadlineConfig = {
      deadlineId: "D1",
      label: "Draft report",
      dueDate: "2025-06-15",
      entityTag: null,
      dependsOn: [],
      status: "upcoming",
      owner: "R001",
      escalationNote: null,
    };
    const {
      deadline: updated,
      reassignment,
      escalated,
    } = applyReassignmentFn(deadline, { toOwner: "P001", reason: "Resource risk — R001 on leave" }, "2025-06-01");
    expect(updated.owner).toBe("P001");
    expect(updated.status).toBe("escalated");
    expect(updated.escalationNote).toContain("risk");
    expect(reassignment.fromOwner).toBe("R001");
    expect(reassignment.toOwner).toBe("P001");
    expect(reassignment.reason).toBe("Resource risk — R001 on leave");
    expect(reassignment.reassignedAt).toBe("2025-06-01");
    expect(escalated).toBe(true);
  });

  it("does not escalate when the reason is benign", () => {
    const deadline: EngagementDeadlineConfig = {
      deadlineId: "D1",
      label: "Draft report",
      dueDate: "2025-06-15",
      entityTag: null,
      dependsOn: [],
      status: "upcoming",
      owner: "R001",
      escalationNote: null,
    };
    const { deadline: updated, escalated } = applyReassignmentFn(
      deadline,
      { toOwner: "P001", reason: "Workload rebalancing" },
      "2025-06-01",
    );
    expect(updated.owner).toBe("P001");
    expect(updated.status).toBe("upcoming");
    expect(escalated).toBe(false);
  });
});

describe("firm-wide practice management — document management", () => {
  it("validates document version chronology", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          documents: [
            {
              documentId: "DOC1",
              name: "Report",
              type: "report",
              version: 1,
              documentClass: "final-report",
              uploadedAt: "2025-06-01",
              ownerUserId: "P001",
              status: "final",
              retentionUntil: "2030-06-01",
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
            {
              documentId: "DOC2",
              name: "Report",
              type: "report",
              version: 2,
              documentClass: "final-report",
              uploadedAt: "2025-06-05",
              ownerUserId: "P001",
              status: "final",
              retentionUntil: "2030-06-01",
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
          ],
          deadlines: [],
          workpapers: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.warnings).not.toContainEqual(expect.stringMatching(/version/));
  });

  it("flags documents whose version is not newer than a prior version", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          documents: [
            {
              documentId: "DOC1",
              name: "Report",
              type: "report",
              version: 2,
              documentClass: "final-report",
              uploadedAt: "2025-06-01",
              ownerUserId: "P001",
              status: "final",
              retentionUntil: null,
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
            {
              documentId: "DOC2",
              name: "Report",
              type: "report",
              version: 1,
              documentClass: "final-report",
              uploadedAt: "2025-06-05",
              ownerUserId: "P001",
              status: "final",
              retentionUntil: null,
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
          ],
          deadlines: [],
          workpapers: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.warnings).toContainEqual(expect.stringMatching(/version 1 is not newer than version 2/));
  });

  it("counts unsigned final reports and signed copies", () => {
    const res = buildPracticeWorkspace(BASE);
    const unsigned = res.firmAnalytics.overdueWork.unsignedDocumentCount;
    // E1 DOC2 final-report, status final → unsigned; E2 DOC1 working-paper → not counted
    expect(unsigned).toBeGreaterThanOrEqual(1);
  });

  it("enforces client access control by role", () => {
    const doc: DocumentConfig = {
      documentId: "DOC1",
      name: "Confidential report",
      type: "report",
      version: 1,
      documentClass: "final-report",
      uploadedAt: "2025-06-01",
      ownerUserId: "P001",
      status: "final",
      retentionUntil: null,
      allowedRoles: ["partner"] as PracticeAccessRole[],
    };
    expect(roleMayAccess("partner", doc.allowedRoles)).toBe(true);
    expect(roleMayAccess("reviewer", doc.allowedRoles)).toBe(false);
    expect(roleMayAccess("assistant", doc.allowedRoles)).toBe(false);
  });

  it("identifies documents past their retention date", () => {
    const docs: DocumentConfig[] = [
      {
        documentId: "DOC1",
        name: "Old report",
        type: "report",
        version: 1,
        documentClass: "final-report",
        uploadedAt: "2020-01-01",
        ownerUserId: "P001",
        status: "final",
        retentionUntil: "2022-01-01",
        allowedRoles: ["partner"] as PracticeAccessRole[],
      },
      {
        documentId: "DOC2",
        name: "Current report",
        type: "report",
        version: 1,
        documentClass: "final-report",
        uploadedAt: "2024-01-01",
        ownerUserId: "P001",
        status: "final",
        retentionUntil: "2029-01-01",
        allowedRoles: ["partner"] as PracticeAccessRole[],
      },
    ];
    const past = documentsPastRetentionFn(docs, "2023-01-01");
    expect(past).toHaveLength(1);
    expect(past[0]!.name).toBe("Old report");
  });
});

describe("firm-wide practice management — client isolation, roles, assignment", () => {
  it("validates client → engagement mapping and flags unknown clients", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          deadlines: [],
          workpapers: [],
          documents: [],
          phases: [],
        }),
        engagement("E3", "CLIENT-X", "Unknown client", "in-progress", {
          deadlines: [],
          workpapers: [],
          documents: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.warnings).toContainEqual(expect.stringMatching(/unknown client CLIENT-X/));
  });

  it("computes client access summary with allowed roles", () => {
    const summary = clientAccessSummaryFn(BASE.clients);
    expect(summary.find((c) => c.clientId === "CLIENT-A")!.allowedRoles).toEqual(["partner", "reviewer", "assistant"]);
    expect(summary.find((c) => c.clientId === "CLIENT-B")!.allowedRoles).toEqual(["partner", "reviewer"]);
  });

  it("tracks assignment review status per user", () => {
    // R001 is reviewer on both engagements; WP2 in-review on E1, WP1 in-review on E2
    const status = assignmentReviewStatusFn(BASE.engagements, "R001");
    expect(status.pendingWorkpapers).toBe(2);
    expect(status.engagementCount).toBe(2);
    const p001 = assignmentReviewStatusFn(BASE.engagements, "P001");
    expect(p001.pendingWorkpapers).toBe(0);
    expect(p001.engagementCount).toBe(2);
  });

  it("counts pending documents in draft/final for the owning user", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      engagements: [
        engagement("E1", "CLIENT-A", "Acme", "in-progress", {
          documents: [
            {
              documentId: "DOC1",
              name: "Draft report",
              type: "report",
              version: 1,
              documentClass: "final-report",
              uploadedAt: "2025-06-01",
              ownerUserId: "R001",
              status: "draft",
              retentionUntil: null,
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
            {
              documentId: "DOC2",
              name: "Final report",
              type: "report",
              version: 2,
              documentClass: "final-report",
              uploadedAt: "2025-06-05",
              ownerUserId: "R001",
              status: "final",
              retentionUntil: null,
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
            {
              documentId: "DOC3",
              name: "Signed report",
              type: "report",
              version: 1,
              documentClass: "signed-copy",
              uploadedAt: "2025-06-10",
              ownerUserId: "R001",
              status: "signed",
              retentionUntil: null,
              allowedRoles: ["partner"] as PracticeAccessRole[],
            },
          ],
          deadlines: [],
          workpapers: [],
          phases: [],
        }),
      ],
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    const status = assignmentReviewStatusFn(res.engagements, "R001");
    // DOC1 draft + DOC2 final → 2 pending
    expect(status.pendingDocuments).toBe(2);
  });
});

describe("firm-wide practice management — firm-level reporting", () => {
  it("computes realisation roll-up across all engagements", () => {
    const res = buildPracticeWorkspace(BASE);
    const r = res.firmAnalytics.realisation;
    // Total budget 800k, billed 650k, realised 500k → realisation 62.5%
    expect(r.totalFeeBudget).toBe(800_000);
    expect(r.totalFeeBilled).toBe(650_000);
    expect(r.totalFeeRealised).toBe(500_000);
    expect(r.realisationPct).toBeCloseTo(62.5, 2);
  });

  it("computes weighted pipeline roll-up", () => {
    const res = buildPracticeWorkspace(BASE);
    const p = res.firmAnalytics.pipeline;
    // E1 budgeted 500k billed 400k → pipeline 100k (in-progress, weight 0.6)
    // E2 budgeted 300k billed 250k → pipeline 50k (under-review, weight 0.9)
    // total pipeline = 150k; weighted = 100k*0.6 + 50k*0.9 = 60k + 45k = 105k
    expect(p.totalPipeline).toBe(150_000);
    expect(p.weightedPipeline).toBeCloseTo(105_000, 2);
    expect(p.inScopeCount).toBe(0);
    expect(p.inProgressCount).toBe(2);
    expect(p.underReviewCount).toBe(1);
  });

  it("computes overdue work roll-up with per-client breakdown", () => {
    const res = buildPracticeWorkspace(BASE);
    const o = res.firmAnalytics.overdueWork;
    expect(o.overdueDeadlineCount).toBeGreaterThanOrEqual(2);
    expect(o.escalatedDeadlineCount).toBe(0);
    expect(o.openWorkpaperCount).toBeGreaterThanOrEqual(3);
    expect(o.pendingReviewCount).toBeGreaterThanOrEqual(2);
    const acme = o.byClient.find((c) => c.clientId === "CLIENT-A");
    expect(acme!.name).toBe("Acme Industries Ltd");
    const beta = o.byClient.find((c) => c.clientId === "CLIENT-B");
    expect(beta!.overdueDeadlines).toBeGreaterThanOrEqual(2);
  });

  it("computes staffing load roll-up with per-person allocation and review queues", () => {
    const res = buildPracticeWorkspace(BASE);
    const s = res.firmAnalytics.staffingLoad;
    expect(s.totalTimeRecordedHours).toBe(200);
    const p001 = s.byPerson.find((p) => p.userId === "P001");
    expect(p001).toBeDefined();
    expect(p001!.role).toBe("partner");
    expect(p001!.engagementCount).toBe(2);
    const r001 = s.byPerson.find((p) => p.userId === "R001");
    expect(r001).toBeDefined();
    expect(r001!.role).toBe("reviewer");
    const reviewerQueue = s.reviewQueueByReviewer.find((q) => q.reviewerUserId === "R001");
    expect(reviewerQueue).toBeDefined();
    expect(reviewerQueue!.pendingWorkpaperCount).toBe(2);
    // R001 owns WP2 in-review on E1, WP1 in-review on E2 → 2 pending
    expect(reviewerQueue!.pendingWorkpaperCount).toBe(2);
  });

  it("returns empty analytics when scopes are turned off", () => {
    const res = buildPracticeWorkspace({
      ...BASE,
      analytics: { realisation: false, pipeline: false, overdue: false, complianceDueList: false, staffingLoad: false },
    });
    expect(res.firmAnalytics.realisation.realisationPct).toBe(0);
    expect(res.firmAnalytics.pipeline.totalPipeline).toBe(0);
    expect(res.firmAnalytics.overdueWork.overdueDeadlineCount).toBe(0);
    expect(res.firmAnalytics.complianceDueList).toHaveLength(0);
    expect(res.firmAnalytics.staffingLoad.totalTimeRecordedHours).toBe(0);
  });
});

const applyReassignmentFn = applyReassignment;
const documentsPastRetentionFn = documentsPastRetention;
const clientAccessSummaryFn = clientAccessSummary;
const assignmentReviewStatusFn = assignmentReviewStatus;
