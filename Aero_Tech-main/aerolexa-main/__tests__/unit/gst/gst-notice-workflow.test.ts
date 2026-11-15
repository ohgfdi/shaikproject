import {
  linkNoticeToReconciliation,
  generateResponseDraft,
  buildNoticeWorklist,
  buildNoticeTimeline,
  findRelevantPrecedents,
  type GstNotice,
  type ReconciliationArtifact,
  type NoticeResponse,
  BUILT_IN_PRECEDENTS,
} from "@/lib/engine/gst-notice-workflow";
import { INR } from "@/lib/engine/india-tax";

describe("GST Notice Workflow Engine", () => {
  const createTestNotice = (overrides: Partial<GstNotice> = {}): GstNotice => ({
    id: "notice-1",
    noticeNumber: "ASMT-10/2025/001",
    noticeDate: "2025-01-15",
    noticeType: "asmt-10",
    authorityLevel: "proper-officer",
    authorityName: "Proper Officer, Mumbai",
    authorityJurisdiction: "Mumbai",
    gstin: "27AAAAA0000A1Z5",
    entityName: "Test Corp Pvt Ltd",
    period: "2024-12",
    subject: "Scrutiny of GSTR-3B for Dec 2024",
    description: "Discrepancy in ITC claimed vs GSTR-2B",
    sections: ["s 61", "s 16(2)(aa)"],
    rules: ["Rule 36(4)"],
    demandedAmount: { tax: INR(50000), interest: INR(5000), penalty: INR(10000), total: INR(65000) },
    responseDueDate: "2025-02-15",
    status: "received",
    priority: "high",
    tags: ["itc-reversal", "gstr-2b-mismatch"],
    createdAt: "2025-01-15T10:00:00Z",
    updatedAt: "2025-01-15T10:00:00Z",
    ...overrides,
  });

  const createTestArtifact = (overrides: Partial<ReconciliationArtifact> = {}): ReconciliationArtifact => ({
    type: "gstr-2b-recon",
    period: "2024-12",
    entityId: "entity-1",
    summary: {
      totalMismatches: 3,
      totalTaxImpact: INR(50000),
      keyFindings: ["3 invoices missing in GSTR-2B", "Rule 36(4) excess ITC ₹25,000"],
    },
    details: {
      invoices: [
        { invoiceNumber: "INV-001", gstin: "29BBBBB0000B1Z4", issue: "Missing in GSTR-2B", taxImpact: INR(18000) },
        { invoiceNumber: "INV-002", gstin: "29BBBBB0000B1Z4", issue: "Rate mismatch", taxImpact: INR(5000) },
      ],
      blockedItc: [{ category: "motor-vehicle", amount: INR(25000), section: "s 17(5)(a)" }],
      missingInvoices: [{ gstin: "29BBBBB0000B1Z4", count: 3, estimatedTax: INR(50000) }],
    },
    generatedAt: "2025-01-10T10:00:00Z",
    generatedBy: "user-1",
    ...overrides,
  });

  describe("linkNoticeToReconciliation", () => {
    it("should link relevant artifacts to notice", () => {
      const notice = createTestNotice({ noticeType: "itc-reversal" });
      const artifacts = [createTestArtifact()];

      const result = linkNoticeToReconciliation(notice, artifacts);

      expect(result.linkedArtifacts).toHaveLength(1);
      expect(result.evidenceSummary).toContain("1 reconciliation artifact(s)");
      expect(result.evidenceSummary).toContain("gstr-2b-recon");
    });

    it("should identify gaps when evidence is insufficient", () => {
      const notice = createTestNotice({
        demandedAmount: { tax: INR(100000), interest: 0, penalty: 0, total: INR(100000) },
      });
      const artifacts = [createTestArtifact()];

      const result = linkNoticeToReconciliation(notice, artifacts);

      expect(result.gaps.length).toBeGreaterThan(0);
      expect(result.gaps[0]).toContain("covers only");
    });

    it("should return no artifacts for irrelevant types", () => {
      const notice = createTestNotice({ noticeType: "e-way-bill" });
      const artifacts = [createTestArtifact()];

      const result = linkNoticeToReconciliation(notice, artifacts);

      expect(result.linkedArtifacts).toHaveLength(0);
      expect(result.evidenceSummary).toContain("No reconciliation artifacts linked");
    });
  });

  describe("generateResponseDraft", () => {
    it("should generate structured response with computations from artifacts", () => {
      const notice = createTestNotice();
      const artifacts = [createTestArtifact()];

      const response = generateResponseDraft(notice, artifacts, {});

      expect(response.noticeId).toBe(notice.id);
      expect(response.responseType).toBe("reply");
      expect(response.status).toBe("draft");
      expect(response.content.facts).toContain(notice.noticeNumber);
      expect(response.content.legalArguments.length).toBeGreaterThan(0);
      expect(response.content.computations.length).toBeGreaterThan(0);
      expect(response.content.prayers.length).toBeGreaterThan(0);
      expect(response.attachments.length).toBe(1);
    });

    it("should include partial admission when specified", () => {
      const notice = createTestNotice();
      const artifacts = [createTestArtifact()];

      const response = generateResponseDraft(notice, artifacts, {
        admitPartially: [{ head: "Interest", amount: INR(5000), reason: "Interest admitted" }],
      });

      expect(response.responseType).toBe("clarification");
      expect(response.content.prayers.some((p) => p.includes("Admit liability"))).toBe(true);
    });

    it("should include full admission when specified", () => {
      const notice = createTestNotice();
      const artifacts = [createTestArtifact()];

      const response = generateResponseDraft(notice, artifacts, { admitFully: true });

      expect(response.responseType).toBe("payment");
    });
  });

  describe("buildNoticeTimeline", () => {
    it("should build timeline with notice received event", () => {
      const notice = createTestNotice();

      const timeline = buildNoticeTimeline(notice);

      expect(timeline.events).toHaveLength(1);
      expect(timeline.events[0]!.event).toBe("Notice Received");
      expect(timeline.criticalDates[0]!.label).toBe("Response Due Date");
    });

    it("should include response events when response exists", () => {
      const notice = createTestNotice();
      const response: NoticeResponse = {
        id: "resp-1",
        noticeId: notice.id,
        responseNumber: "RESP-001",
        responseDate: "2025-01-20",
        responseType: "reply",
        draftedBy: "user-1",
        status: "filed",
        content: { facts: "", legalArguments: [], evidenceReferences: [], computations: [], prayers: [] },
        attachments: [],
        filedDate: "2025-01-20",
        filingMode: "portal",
        createdAt: "2025-01-20T10:00:00Z",
        updatedAt: "2025-01-20T10:00:00Z",
      };

      const timeline = buildNoticeTimeline(notice, response);

      expect(timeline.events.length).toBeGreaterThanOrEqual(2);
      expect(timeline.events.some((e) => e.event === "Response Drafted")).toBe(true);
      expect(timeline.events.some((e) => e.event === "Response Filed")).toBe(true);
    });
  });

  describe("buildNoticeWorklist", () => {
    it("should prioritize notices by risk score", () => {
      const notice1 = createTestNotice({
        id: "notice-1",
        priority: "critical",
        responseDueDate: "2025-01-20",
        demandedAmount: { tax: INR(1000000), interest: INR(100000), penalty: INR(200000), total: INR(1300000) },
      });
      const notice2 = createTestNotice({
        id: "notice-2",
        priority: "low",
        responseDueDate: "2025-02-15",
        demandedAmount: undefined,
      });

      const worklist = buildNoticeWorklist([notice1, notice2], [], new Map());

      expect(worklist[0]!.notice.id).toBe("notice-1");
      expect(worklist[0]!.riskScore).toBeGreaterThanOrEqual(worklist[1]!.riskScore);
    });

    it("should flag overdue notices", () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 5);
      const overdueDate = pastDate.toISOString().split("T")[0];

      const notice = createTestNotice({ responseDueDate: overdueDate, priority: "high" });
      const worklist = buildNoticeWorklist([notice], [], new Map());

      expect(worklist[0]!.recommendedAction).toContain("OVERDUE");
    });
  });

  describe("findRelevantPrecedents", () => {
    it("should find precedents matching notice sections", () => {
      const notice = createTestNotice({ sections: ["s 16(2)(aa)"], tags: ["itc-reversal"] });

      const precedents = findRelevantPrecedents(notice, 5);

      expect(precedents.length).toBeGreaterThan(0);
      expect(precedents.some((p) => p.sections.includes("s 16(2)(aa)"))).toBe(true);
    });

    it("should prioritize taxpayer-favorable SC judgments", () => {
      const notice = createTestNotice({ sections: ["s 17(5)(c)"], tags: ["blocked-itc"] });

      const precedents = findRelevantPrecedents(notice, 5);

      expect(precedents[0]!.favorableTo).toBe("taxpayer");
      expect(precedents[0]!.court).toBe("SC");
    });
  });

  describe("BUILT_IN_PRECEDENTS", () => {
    it("should have key precedents for ITC reversal", () => {
      const itcPrecedents = BUILT_IN_PRECEDENTS.filter((p) => p.tags.includes("itc-reversal"));
      expect(itcPrecedents.length).toBeGreaterThan(0);
    });

    it("should have key precedents for blocked ITC", () => {
      const blockedPrecedents = BUILT_IN_PRECEDENTS.filter((p) => p.tags.includes("blocked-itc"));
      expect(blockedPrecedents.length).toBeGreaterThan(0);
    });
  });
});
