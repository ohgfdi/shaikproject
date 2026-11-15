/**
 * Route-level integration for `POST /api/ca/compute` with
 * `kind: "practiceman"`. Proves the route reaches the practice-management
 * adapter, runs the full build op, and maps an engine refusal to a 400 (not a
 * 500).
 */

import { POST } from "@/app/api/ca/compute/route";

jest.mock("@/lib/auth/guard", () => {
  const actual = jest.requireActual("@/lib/auth/guard");
  return {
    ...actual,
    requireAuth: jest.fn(async () => ({
      user: { id: "u1" },
      workspace: { id: "w1" },
      settings: {},
      organization: null,
      organizationRole: null,
    })),
  };
});

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/ca/compute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
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

describe("POST /api/ca/compute · practiceman", () => {
  it("routes the build op and returns the full firm-wide operating system view", async () => {
    const res = await post({
      kind: "practiceman",
      op: "build",
      config: {
        firm: FIRM,
        clients: [CLIENT_A],
        engagements: [engagementBase],
        analytics: { realisation: true, pipeline: true, overdue: true, complianceDueList: true, staffingLoad: true },
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.practiceManagement.firm).toEqual({
      firmId: "FIRM-001",
      name: "Ledgerly CA Partners",
      clientCount: 1,
      engagementCount: 1,
    });
    const e = json.data.practiceManagement.engagements[0];
    expect(e.realisationPct).toBe(60);
    expect(e.timeBudgetVariancePct).toBeCloseTo(8, 2);
    expect(e.phaseBreakdown).toHaveLength(2);
    expect(e.phaseBreakdown.find((p: any) => p.phaseId === "P2")!.hoursVariancePct).toBeCloseTo(12.5, 2);
    expect(e.phaseBreakdown.find((p: any) => p.phaseId === "P2")!.feeVariancePct).toBeCloseTo(-20, 2);
  });

  it("returns firm-level analytics across all clients when multiple engagements are supplied", async () => {
    const res = await post({
      kind: "practiceman",
      op: "build",
      config: {
        firm: FIRM,
        clients: [
          CLIENT_A,
          {
            ...CLIENT_A,
            clientId: "CLIENT-B",
            name: "Beta Retail Pvt Ltd",
            allowedRoles: ["partner", "reviewer"] as const,
          },
        ],
        engagements: [
          engagementBase,
          {
            ...engagementBase,
            engagementId: "E2",
            matter: "Beta Retail Pvt Ltd",
            // Under review, not in progress: the second pipeline weights by
            // status, so this is what makes the 0.6 / 0.9 split below true.
            status: "under-review" as const,
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
        analytics: { realisation: true, pipeline: true, overdue: true, complianceDueList: true, staffingLoad: false },
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const r = json.data.practiceManagement.firmAnalytics.realisation;
    expect(r.totalFeeBudget).toBe(800_000);
    expect(r.totalFeeBilled).toBe(650_000);
    expect(r.totalFeeRealised).toBe(500_000);
    expect(r.realisationPct).toBeCloseTo(62.5, 2);
    const p = json.data.practiceManagement.firmAnalytics.pipeline;
    expect(p.totalPipeline).toBe(150_000);
    expect(p.weightedPipeline).toBeCloseTo(105_000, 2);
    expect(p.inProgressCount).toBe(2);
  });

  it("maps an invalid config (unknown client mapping) to a 400 with PRACTICE_MANAGEMENT_INPUT", async () => {
    const res = await post({
      kind: "practiceman",
      op: "build",
      config: {
        firm: FIRM,
        clients: [CLIENT_A],
        engagements: [
          {
            ...engagementBase,
            engagementId: "E2",
            clientId: "CLIENT-X",
            matter: "Unknown client",
            deadlines: [],
            workpapers: [],
            documents: [],
            phases: [],
          },
        ],
        analytics: {
          realisation: false,
          pipeline: false,
          overdue: false,
          complianceDueList: false,
          staffingLoad: false,
        },
      },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("PRACTICE_MANAGEMENT_INPUT");
  });

  it("rejects a malformed payload with a 400, not a 500", async () => {
    const res = await post({ kind: "practiceman", op: "build" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("routes the reassign-deadline op and returns the updated deadline with escalation", async () => {
    const res = await post({
      kind: "practiceman",
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
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const op = json.data.practiceManagementOp as any;
    expect(op.op).toBe("reassign-deadline");
    expect(op.deadline.owner).toBe("P001");
    expect(op.deadline.status).toBe("escalated");
    expect(op.deadline.escalationNote).toContain("risk");
    expect(op.reassignment.fromOwner).toBe("R001");
    expect(op.reassignment.toOwner).toBe("P001");
    expect(op.escalated).toBe(true);
  });

  it("routes the document-versions-valid op and returns validity", async () => {
    const res = await post({
      kind: "practiceman",
      op: "document-versions-valid",
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
          retentionUntil: null,
          allowedRoles: ["partner"],
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
          retentionUntil: null,
          allowedRoles: ["partner"],
        },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.practiceManagementOp.valid).toBe(true);
    expect(json.data.practiceManagementOp.errors).toHaveLength(0);
  });

  it("routes the assignment-review-status op and returns pending counts", async () => {
    const res = await post({
      kind: "practiceman",
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
              status: "in-review",
              ownerType: "reviewer",
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
              documentClass: "final-report",
              uploadedAt: "2025-06-01",
              ownerUserId: "R001",
              status: "draft",
              retentionUntil: null,
              allowedRoles: ["partner"],
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
              allowedRoles: ["partner"],
            },
          ],
        },
      ],
      userId: "R001",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const op = json.data.practiceManagementOp as any;
    expect(op.op).toBe("assignment-review-status");
    expect(op.status.userId).toBe("R001");
    expect(op.status.pendingWorkpapers).toBe(1);
    expect(op.status.pendingDocuments).toBe(2);
    expect(op.status.engagementCount).toBe(1);
  });
});
