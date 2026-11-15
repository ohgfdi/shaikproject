/**
 * Practice management API adapter — oracle tests.
 *
 * Pins the Zod op dispatch, the rupee-based money contract (the engine speaks
 * rupees for fee/time; the adapter does NOT convert to paise because the engine
 * already works in rupees — paise conversion lives in the paise-engine adapters
 * like payroll/tds/gst), and the dispatch helpers that the engine suite (which
 * works on the config shape directly) cannot see.
 */

import { practiceManOperations, computePracticeManagement } from "@/lib/engine/ca-practice-management-api";

function run(input: unknown) {
  const parsed = practiceManOperations.parse(input);
  return computePracticeManagement(parsed);
}

const FIRM = {
  firmId: "FIRM-001",
  name: "Ledgerly CA Partners",
  calendarWindowStart: "2025-04-01",
  calendarWindowEnd: "2025-06-30",
};

const CLIENT_A = {
  clientId: "CLIENT-A",
  name: "Acme Industries Ltd",
  identifiers: { cin: "U74999DL2010PLC057890" },
  workpaperTemplateIds: ["TMP-ACA-GST"],
  primaryContact: "Anil Kumar",
  allowedRoles: ["partner", "reviewer", "assistant"] as const,
};

const engagementBase = {
  engagementId: "E1",
  clientId: "CLIENT-A",
  matter: "Acme Industries Ltd",
  status: "in-progress" as const,
  scope: "Statutory audit",
  periodLabel: "2024-25",
  leadPartner: "P001",
  reviewers: ["R001"],
  feeBudget: 500_000,
  feeBilled: 400_000,
  feeRealised: 300_000,
  timeRecordedHours: 120,
  communications: [],
  phases: [
    {
      phaseId: "P1",
      name: "Planning",
      budgetHours: 20,
      actualHours: 18,
      feeBudget: 100_000,
      feeBilled: 80_000,
      status: "completed" as const,
    },
    {
      phaseId: "P2",
      name: "Fieldwork",
      budgetHours: 80,
      actualHours: 90,
      feeBudget: 300_000,
      feeBilled: 240_000,
      status: "in-progress" as const,
    },
  ],
  deadlines: [
    {
      deadlineId: "D1",
      label: "Draft report",
      dueDate: "2025-06-15",
      entityTag: null,
      dependsOn: [],
      status: "upcoming" as const,
      owner: "R001",
    },
  ],
  workpapers: [
    {
      workpaperId: "WP1",
      workpaperNumber: "WP-2025-0417",
      title: "Cash recon",
      familyId: "FAM-CASH",
      templateId: "TMP-ACA-GST",
      status: "draft" as const,
      ownerType: "assistant" as const,
      ownerUserId: "A001",
      crossReferences: [],
      dueDate: "2025-06-10",
      reviewHistory: [],
    },
  ],
  documents: [
    {
      documentId: "DOC1",
      name: "Engagement letter",
      type: "engagement-letter",
      version: 1,
      documentClass: "supporting" as const,
      uploadedAt: "2025-05-01",
      ownerUserId: "P001",
      status: "final" as const,
      retentionUntil: "2030-05-01",
      allowedRoles: ["partner"] as const,
    },
  ],
};

describe("practiceManOperations validation", () => {
  it("accepts a `build` op carrying the full config", () => {
    const parsed = practiceManOperations.parse({
      op: "build",
      config: {
        firm: FIRM,
        clients: [CLIENT_A],
        engagements: [engagementBase],
        analytics: { realisation: true, pipeline: true, overdue: true, complianceDueList: true, staffingLoad: true },
      },
    });
    expect((parsed as any).op).toBe("build");
  });

  it("rejects a `build` op with an invalid date", () => {
    expect(
      practiceManOperations.safeParse({
        op: "build",
        config: {
          firm: { ...FIRM, calendarWindowEnd: "2025/06/30" },
          clients: [CLIENT_A],
          engagements: [engagementBase],
          analytics: { realisation: true, pipeline: true, overdue: true, complianceDueList: true, staffingLoad: true },
        },
      }),
    ).toMatchObject({ success: false });
  });

  it("rejects a `reassign-deadline` op with a bad due date", () => {
    expect(
      practiceManOperations.safeParse({
        op: "reassign-deadline",
        deadline: {
          deadlineId: "D1",
          label: "Draft",
          dueDate: "not-a-date",
          entityTag: null,
          dependsOn: [],
          status: "upcoming",
          owner: "R001",
        },
        toOwner: "P001",
        reason: "Risk",
        asOf: "2025-06-01",
      }),
    ).toMatchObject({ success: false });
  });

  it("rejects an unknown op", () => {
    expect(practiceManOperations.safeParse({ op: "not-a-real-op" })).toMatchObject({ success: false });
  });
});

describe("practice management dispatch — `build` op", () => {
  it("runs the full firm-wide operating system view", () => {
    const result = run({
      op: "build",
      config: {
        firm: FIRM,
        clients: [CLIENT_A],
        engagements: [engagementBase],
        analytics: { realisation: true, pipeline: true, overdue: true, complianceDueList: true, staffingLoad: true },
      },
    }) as { op: "build"; result: any };
    expect(result.op).toBe("build");
    expect(result.result.firm).toEqual({
      firmId: "FIRM-001",
      name: "Ledgerly CA Partners",
      clientCount: 1,
      engagementCount: 1,
    });
    expect(result.result.engagements).toHaveLength(1);
    const e = result.result.engagements[0];
    expect(e.realisationPct).toBe(60);
    expect(e.timeBudgetVariancePct).toBeCloseTo(8, 2);
    expect(e.phaseBreakdown).toHaveLength(2);
    expect(e.phaseBreakdown.find((p: any) => p.phaseId === "P2")!.hoursVariancePct).toBeCloseTo(12.5, 2);
    expect(e.phaseBreakdown.find((p: any) => p.phaseId === "P2")!.feeVariancePct).toBeCloseTo(-20, 2);
  });

  it("computes realisation roll-up in the result", () => {
    const result = run({
      op: "build",
      config: {
        firm: FIRM,
        clients: [CLIENT_A],
        engagements: [
          engagementBase,
          {
            ...engagementBase,
            engagementId: "E2",
            matter: "Beta Retail",
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
                status: "completed" as const,
              },
              {
                phaseId: "P2",
                name: "Fieldwork",
                budgetHours: 60,
                actualHours: 55,
                feeBudget: 200_000,
                feeBilled: 160_000,
                status: "in-progress" as const,
              },
            ],
            deadlines: [],
            workpapers: [],
            documents: [],
          },
        ],
        analytics: {
          realisation: true,
          pipeline: false,
          overdue: false,
          complianceDueList: false,
          staffingLoad: false,
        },
      },
    }) as { op: "build"; result: any };
    const r = result.result.firmAnalytics.realisation;
    expect(r.totalFeeBudget).toBe(800_000);
    expect(r.totalFeeBilled).toBe(650_000);
    expect(r.totalFeeRealised).toBe(500_000);
    expect(r.realisationPct).toBeCloseTo(62.5, 2);
  });
});

describe("practice management dispatch — `realisation` op", () => {
  it("returns engagement-level realisation and budget variance", () => {
    const result = run({
      op: "realisation",
      engagement: engagementBase,
    }) as { op: "realisation"; realisationPct: number; timeBudgetVariancePct: number; warnings: string[] };
    expect(result.op).toBe("realisation");
    expect(result.realisationPct).toBe(60);
    expect(result.timeBudgetVariancePct).toBeCloseTo(8, 2);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when realised exceeds billed", () => {
    const result = run({
      op: "realisation",
      engagement: {
        ...engagementBase,
        feeBudget: 500_000,
        feeBilled: 300_000,
        feeRealised: 400_000,
        timeRecordedHours: 120,
        phases: [
          {
            phaseId: "P1",
            name: "Planning",
            budgetHours: 20,
            actualHours: 18,
            feeBudget: 100_000,
            feeBilled: 80_000,
            status: "completed" as const,
          },
          {
            phaseId: "P2",
            name: "Fieldwork",
            budgetHours: 80,
            actualHours: 90,
            feeBudget: 300_000,
            feeBilled: 240_000,
            status: "in-progress" as const,
          },
        ],
      },
    }) as { op: "realisation"; realisationPct: number; timeBudgetVariancePct: number; warnings: string[] };
    expect(result.warnings).toContainEqual(expect.stringMatching(/realised more than billed/));
  });
});

describe("practice management dispatch — `reassign-deadline` op", () => {
  it("escalates when the reason contains 'risk'", () => {
    const result = run({
      op: "reassign-deadline",
      deadline: {
        deadlineId: "D1",
        label: "Draft report",
        dueDate: "2025-06-15",
        entityTag: null,
        dependsOn: [],
        status: "upcoming",
        owner: "R001",
      },
      toOwner: "P001",
      reason: "Resource risk — R001 on leave",
      asOf: "2025-06-01",
    }) as { op: "reassign-deadline"; deadline: any; reassignment: any; escalated: boolean };
    expect(result.op).toBe("reassign-deadline");
    expect(result.deadline.owner).toBe("P001");
    expect(result.deadline.status).toBe("escalated");
    expect(result.deadline.escalationNote).toContain("risk");
    expect(result.reassignment.fromOwner).toBe("R001");
    expect(result.reassignment.toOwner).toBe("P001");
    expect(result.reassignment.reason).toBe("Resource risk — R001 on leave");
    expect(result.reassignment.reassignedAt).toBe("2025-06-01");
    expect(result.escalated).toBe(true);
  });

  it("does not escalate for a benign reason", () => {
    const result = run({
      op: "reassign-deadline",
      deadline: {
        deadlineId: "D1",
        label: "Draft report",
        dueDate: "2025-06-15",
        entityTag: null,
        dependsOn: [],
        status: "upcoming",
        owner: "R001",
      },
      toOwner: "P001",
      reason: "Workload rebalancing",
      asOf: "2025-06-01",
    }) as { op: "reassign-deadline"; deadline: any; escalated: boolean };
    expect(result.deadline.owner).toBe("P001");
    expect(result.deadline.status).toBe("upcoming");
    expect(result.escalated).toBe(false);
  });

  it("escalates when the reason contains 'escalat'", () => {
    const result = run({
      op: "reassign-deadline",
      deadline: {
        deadlineId: "D1",
        label: "Draft report",
        dueDate: "2025-06-15",
        entityTag: null,
        dependsOn: [],
        status: "upcoming",
        owner: "R001",
      },
      toOwner: "P001",
      reason: "Need escalation",
      asOf: "2025-06-01",
    }) as { op: "reassign-deadline"; escalated: boolean };
    expect(result.escalated).toBe(true);
  });
});

describe("practice management dispatch — `document-versions-valid` op", () => {
  it("returns valid when versions are chronologically increasing", () => {
    const result = run({
      op: "document-versions-valid",
      documents: [
        {
          documentId: "DOC1",
          name: "Report",
          type: "report",
          version: 1,
          documentClass: "final-report" as const,
          uploadedAt: "2025-06-01",
          ownerUserId: "P001",
          status: "final" as const,
          retentionUntil: null,
          allowedRoles: ["partner"] as const,
        },
        {
          documentId: "DOC2",
          name: "Report",
          type: "report",
          version: 2,
          documentClass: "final-report" as const,
          uploadedAt: "2025-06-05",
          ownerUserId: "P001",
          status: "final" as const,
          retentionUntil: null,
          allowedRoles: ["partner"] as const,
        },
      ],
    }) as { op: "document-versions-valid"; valid: boolean; errors: string[] };
    expect(result.op).toBe("document-versions-valid");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns invalid when a later version is older", () => {
    const result = run({
      op: "document-versions-valid",
      documents: [
        {
          documentId: "DOC1",
          name: "Report",
          type: "report",
          version: 2,
          documentClass: "final-report" as const,
          uploadedAt: "2025-06-01",
          ownerUserId: "P001",
          status: "final" as const,
          retentionUntil: null,
          allowedRoles: ["partner"] as const,
        },
        {
          documentId: "DOC2",
          name: "Report",
          type: "report",
          version: 1,
          documentClass: "final-report" as const,
          uploadedAt: "2025-06-05",
          ownerUserId: "P001",
          status: "final" as const,
          retentionUntil: null,
          allowedRoles: ["partner"] as const,
        },
      ],
    }) as { op: "document-versions-valid"; valid: boolean; errors: string[] };
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/version 1 is not newer than version 2/));
  });
});

describe("practice management dispatch — `client-access-summary` op", () => {
  it("returns allowed roles per client", () => {
    const result = run({
      op: "client-access-summary",
      clients: [CLIENT_A, { ...CLIENT_A, clientId: "CLIENT-B", allowedRoles: ["partner", "reviewer"] as const }],
    }) as { op: "client-access-summary"; summary: any[] };
    expect(result.op).toBe("client-access-summary");
    expect(result.summary).toHaveLength(2);
    expect(result.summary.find((c: any) => c.clientId === "CLIENT-A")!.allowedRoles).toEqual([
      "partner",
      "reviewer",
      "assistant",
    ]);
    expect(result.summary.find((c: any) => c.clientId === "CLIENT-B")!.allowedRoles).toEqual(["partner", "reviewer"]);
  });
});

describe("practice management dispatch — `assignment-review-status` op", () => {
  it("returns pending workpapers and documents for a reviewer", () => {
    const result = run({
      op: "assignment-review-status",
      engagements: [
        {
          ...engagementBase,
          workpapers: [
            {
              workpaperId: "WP1",
              workpaperNumber: "WP-2025-0417",
              title: "Cash recon",
              familyId: "FAM-CASH",
              templateId: "TMP-ACA-GST",
              status: "in-review" as const,
              ownerType: "reviewer" as const,
              ownerUserId: "R001",
              crossReferences: [],
              dueDate: "2025-06-10",
              reviewHistory: [],
            },
          ],
          documents: [
            {
              documentId: "DOC1",
              name: "Draft report",
              type: "report",
              version: 1,
              documentClass: "final-report" as const,
              uploadedAt: "2025-06-01",
              ownerUserId: "R001",
              status: "draft" as const,
              retentionUntil: null,
              allowedRoles: ["partner"] as const,
            },
            {
              documentId: "DOC2",
              name: "Final report",
              type: "report",
              version: 2,
              documentClass: "final-report" as const,
              uploadedAt: "2025-06-05",
              ownerUserId: "R001",
              status: "final" as const,
              retentionUntil: null,
              allowedRoles: ["partner"] as const,
            },
          ],
        },
      ],
      userId: "R001",
    }) as { op: "assignment-review-status"; status: any };
    expect(result.op).toBe("assignment-review-status");
    expect(result.status.userId).toBe("R001");
    expect(result.status.pendingWorkpapers).toBe(1);
    expect(result.status.pendingDocuments).toBe(2);
    expect(result.status.engagementCount).toBe(1);
  });

  it("returns zero pending when the user has no assignments", () => {
    const result = run({
      op: "assignment-review-status",
      engagements: [engagementBase],
      userId: "UNKNOWN",
    }) as { op: "assignment-review-status"; status: any };
    expect(result.status.pendingWorkpapers).toBe(0);
    expect(result.status.pendingDocuments).toBe(0);
    expect(result.status.engagementCount).toBe(0);
  });
});
