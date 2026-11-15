/**
 * Retention + portability tests (Phase 5.3).
 *
 * The portability tests run against the real Prisma client against a test
 * SQLite database, because the property that matters — "does the bundle
 * actually contain the content, and does it actually withhold the secrets" —
 * cannot be proven by inspecting a list of section names.
 */
import fs from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/db";
import {
  EXPORT_SECTIONS,
  NOT_EXPORTED,
  PROFILE_MODELS,
  WITHHELD_FIELDS,
  buildPortabilityBundle,
} from "@/lib/server/portability";
import {
  RETENTION_POLICIES,
  maybeRunRetentionSweep,
  resetRetentionSweepGuard,
  runRetentionSweep,
} from "@/lib/server/retention";

const DAY = 86_400_000;
const now = () => new Date();

async function seedUser(overrides: Record<string, unknown> = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return prisma.user.create({
    data: {
      email: `privacy-${suffix}@example.com`,
      name: "Privacy Subject",
      passwordHash: "!test-hash",
      ...overrides,
    },
  });
}

afterEach(async () => {
  // Clean in FK-safe order; workspaces cascade to everything inside them.
  await prisma.workspace.deleteMany({ where: { name: { startsWith: "Privacy WS" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "privacy-" } } });
});

describe("retention policy", () => {
  it("declares a unique id and a basis for every policy", () => {
    const ids = RETENTION_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of RETENTION_POLICIES) {
      expect(p.description.length).toBeGreaterThan(0);
      // A retention window with no stated legal/business basis is an arbitrary
      // deletion, which is exactly what a regulator challenges.
      expect(p.basis.length).toBeGreaterThan(20);
    }
  });

  it("sweeps expired error reports but keeps recent ones", async () => {
    const user = await seedUser();
    const old = new Date(now().getTime() - 200 * DAY);
    await prisma.errorReport.create({
      data: { fingerprint: `old-${user.id}`, name: "TypeError", message: "boom", resolvedAt: old, lastSeenAt: old },
    });
    await prisma.errorReport.create({
      data: { fingerprint: `new-${user.id}`, name: "TypeError", message: "boom", resolvedAt: now(), lastSeenAt: now() },
    });

    const result = await runRetentionSweep(now());
    expect(result.deleted["error-reports-resolved"]).toBeGreaterThanOrEqual(1);
    expect(result.totalDeleted).toBeGreaterThanOrEqual(1);

    expect(await prisma.errorReport.findUnique({ where: { fingerprint: `old-${user.id}` } })).toBeNull();
    expect(await prisma.errorReport.findUnique({ where: { fingerprint: `new-${user.id}` } })).not.toBeNull();
  });

  it("gives an untriaged error report a longer window than a resolved one", async () => {
    const user = await seedUser();
    const stale = new Date(now().getTime() - 120 * DAY); // past 90d, not past 180d
    await prisma.errorReport.create({
      data: { fingerprint: `open-${user.id}`, name: "RangeError", message: "still open", lastSeenAt: stale },
    });

    await runRetentionSweep(now());

    // 120 days: inside the open window, so triage is not destroyed early.
    expect(await prisma.errorReport.findUnique({ where: { fingerprint: `open-${user.id}` } })).not.toBeNull();
  });

  it("purges expired auth tokens", async () => {
    const user = await seedUser();
    await prisma.verificationToken.create({
      data: {
        tokenHash: `expired-${user.id}`,
        userId: user.id,
        kind: "VERIFY_EMAIL",
        expiresAt: new Date(now().getTime() - 2 * DAY),
      },
    });
    await prisma.verificationToken.create({
      data: {
        tokenHash: `live-${user.id}`,
        userId: user.id,
        kind: "VERIFY_EMAIL",
        expiresAt: new Date(now().getTime() + 2 * DAY),
      },
    });

    await runRetentionSweep(now());

    expect(await prisma.verificationToken.findUnique({ where: { tokenHash: `expired-${user.id}` } })).toBeNull();
    // A live token is a working credential — retention must never remove one.
    expect(await prisma.verificationToken.findUnique({ where: { tokenHash: `live-${user.id}` } })).not.toBeNull();
  });

  it("never sweeps consent records or the activity audit trail", async () => {
    // These two are legal records, not telemetry. A generic "delete old rows"
    // sweep would quietly destroy exactly what a CA firm needs to prove
    // compliance, so the absence is asserted rather than assumed.
    const source = fs.readFileSync(path.join(process.cwd(), "lib/server/retention.ts"), "utf8");
    expect(source).not.toContain("consentRecord.deleteMany");
    expect(source).not.toContain("activity.deleteMany");
    expect(source).not.toContain("feedback.deleteMany");
  });

  it("isolates a failing policy instead of aborting the sweep", async () => {
    const broken = {
      id: "broken",
      description: "always throws",
      basis: "test double",
      run: async () => {
        throw new Error("table is gone");
      },
    };
    RETENTION_POLICIES.push(broken as (typeof RETENTION_POLICIES)[number]);
    try {
      const result = await runRetentionSweep(now());
      expect(result.failures.map((f) => f.id)).toContain("broken");
      expect(result.deleted.broken).toBe(0);
      // Everything else still ran.
      expect(Object.keys(result.deleted).length).toBe(RETENTION_POLICIES.length);
    } finally {
      RETENTION_POLICIES.splice(RETENTION_POLICIES.indexOf(broken as (typeof RETENTION_POLICIES)[number]), 1);
    }
  });

  it("runs at most once per day", async () => {
    resetRetentionSweepGuard();
    expect(await maybeRunRetentionSweep(now())).not.toBeNull();
    expect(await maybeRunRetentionSweep(now())).toBeNull();
    // Next day, it runs again.
    expect(await maybeRunRetentionSweep(new Date(now().getTime() + DAY))).not.toBeNull();
    resetRetentionSweepGuard();
  });
});

describe("portability bundle", () => {
  it("exports the subject's authored content, not just metadata stubs", async () => {
    const workspace = await prisma.workspace.create({ data: { name: `Privacy WS ${Math.random()}` } });
    const user = await seedUser({ workspaceId: workspace.id });

    const dataset = await prisma.dataset.create({
      data: {
        workspaceId: workspace.id,
        name: "trial_balance",
        originalName: "tb.csv",
        mimeType: "text/csv",
        sizeBytes: 1024,
        rowCount: 2,
        columnCount: 2,
        ndjsonPath: "/secret/host/path/tb.ndjson",
        columns: JSON.stringify([{ key: "amount", label: "Amount" }]),
        createdById: user.id,
      },
    });
    const notebook = await prisma.notebook.create({
      data: {
        workspaceId: workspace.id,
        title: "GST recon",
        // The actual authored content — this is what the stub export omitted.
        cells: JSON.stringify([{ kind: "code", source: "SELECT * FROM trial_balance" }]),
        createdById: user.id,
      },
    });
    const chat = await prisma.chat.create({ data: { workspaceId: workspace.id, userId: user.id, title: "Q3 thread" } });
    await prisma.chatMessage.create({ data: { chatId: chat.id, role: "user", content: "reconcile GSTR-1" } });

    const bundle = (await buildPortabilityBundle(user.id)) as Record<string, any>;

    const notebooks = bundle.notebooks as any[];
    expect(notebooks.find((n) => n.id === notebook.id)?.cells).toContain("SELECT * FROM trial_balance");

    const messages = bundle.chatMessages as any[];
    expect(messages.some((m) => m.content === "reconcile GSTR-1")).toBe(true);

    const datasets = bundle.datasets as any[];
    expect(datasets.find((d) => d.id === dataset.id)?.columns).toContain("amount");

    void bundle.analyses;
  });

  it("withholds credentials and host paths from the bundle", async () => {
    const workspace = await prisma.workspace.create({ data: { name: `Privacy WS ${Math.random()}` } });
    const user = await seedUser({ workspaceId: workspace.id, passwordHash: "$2b$10$supersecret" });

    await prisma.connector.create({
      data: {
        workspaceId: workspace.id,
        name: "prod-pg",
        // Stands in for the encrypted blob that decrypts to a DB password.
        config: "enc:v1:VEhJU0lzTUFGQUNJTg==",
        webhookSecret: "whsec_live_value",
        createdById: user.id,
      },
    });
    await prisma.dataset.create({
      data: {
        workspaceId: workspace.id,
        name: "d",
        originalName: "d.csv",
        mimeType: "text/csv",
        sizeBytes: 1,
        rowCount: 1,
        columnCount: 1,
        ndjsonPath: "/srv/ledgerly/data/secret.ndjson",
        filePath: "/srv/ledgerly/uploads/secret.csv",
        columns: "[]",
        createdById: user.id,
      },
    });

    const raw = JSON.stringify(await buildPortabilityBundle(user.id));

    // The single most important assertion in this file.
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("VEhJU0lzTUFGQUNJTg");
    expect(raw).not.toContain("whsec_live_value");
    expect(raw).not.toContain("/srv/ledgerly");
    expect(raw).not.toContain("secret.ndjson");

    // The omission must be DISCLOSED, not silent.
    const bundle = (await buildPortabilityBundle(user.id)) as Record<string, any>;
    const withheldModels = bundle.manifest.withheldFields.map((w: { model: string }) => w.model);
    expect(withheldModels).toContain("Connector");
    expect(withheldModels).toContain("User");
    for (const w of WITHHELD_FIELDS) expect(w.reason.length).toBeGreaterThan(20);
  });

  it("reports every section in the manifest and flags completeness", async () => {
    const user = await seedUser();
    const bundle = (await buildPortabilityBundle(user.id)) as Record<string, any>;

    expect(bundle.manifest.complete).toBe(true);
    expect(bundle.manifest.sections.length).toBe(EXPORT_SECTIONS.length);
    for (const section of EXPORT_SECTIONS) {
      expect(bundle.manifest.sections.some((s: { key: string }) => s.key === section.key)).toBe(true);
      // Every declared section is present as a key, even when empty.
      expect(Object.prototype.hasOwnProperty.call(bundle, section.key)).toBe(true);
    }
  });

  it("does not leak one subject's chats into another's export", async () => {
    const workspace = await prisma.workspace.create({ data: { name: `Privacy WS ${Math.random()}` } });
    const alice = await seedUser({ workspaceId: workspace.id });
    // Bob has no personal workspace, but his conversation lives in Alice's.
    // Workspace scoping alone would hand Alice his private thread.
    const bob = await seedUser({ workspaceId: null });

    const bobChat = await prisma.chat.create({
      data: { workspaceId: workspace.id, userId: bob.id, title: "Bob confidential" },
    });
    await prisma.chatMessage.create({ data: { chatId: bobChat.id, role: "user", content: "salary-review-notes" } });

    const raw = JSON.stringify(await buildPortabilityBundle(alice.id));

    expect(raw).not.toContain("Bob confidential");
    expect(raw).not.toContain("salary-review-notes");

    // ...and Bob's own export does contain his data.
    expect(JSON.stringify(await buildPortabilityBundle(bob.id))).toContain("salary-review-notes");
  });

  it("covers every personal-data model in the schema, or explains the omission", () => {
    // The bundle is only as good as its coverage. Rather than trusting a
    // hand-maintained list, read the actual schema and require each model to be
    // declared by a section (via `models`) or explicitly justified below.
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]!);

    // Models that genuinely hold no personal data, each with the reason. If
    // someone adds a model to the schema and forgets the bundle, this test
    // fails and the reason has to be written down.
    const NO_PERSONAL_DATA: Record<string, string> = {
      Plan: "Public pricing catalogue. Contains no data about a person.",
      ProjectJoinMapping: "Join table describing how two datasets relate. No person is described by it.",
      NotebookDataset: "Pure join table between Notebook and Dataset.",
      AnalysisDataset: "Pure join table between Analysis and Dataset.",
      JobQueue: "Internal work queue. Its rows carry schedule ids, and it is purged by the retention sweep.",
      WebhookEvent: "Inbound provider event ids used only for delivery de-duplication. Purged by the retention sweep.",
      CollaborativeUpdate:
        "Opaque Yjs binary update frames for collaborative editing. The authored notebook content they carry is already exported in full by the `notebooks` section.",

      // Engagement governance / reporting models — hold client engagement data, not personal data of the subject
      EngagementReportFormat: "Report format template definitions. No personal data.",
      EngagementReportTemplate: "Report templates for client engagements. No personal data.",
      EngagementDeliverableVersion: "Versioned deliverables for client engagements. Client data, not subject data.",
      EngagementDeliverableSignOff: "Sign-off records for engagement deliverables. Client/audit data.",
      EngagementDeliverablePart: "Component parts of engagement deliverables. Client data.",
      EngagementDeliverableRedaction: "Redaction metadata for engagement deliverables. Audit/compliance data.",
      OrganizationReportTemplate: "Report templates at organization level. No personal data.",

      // GST models — hold business transaction data (invoices, transactions), not personal data of the subject
      GstInvoice: "GST invoice records for business transactions. Client/business data, not subject personal data.",
      GstEntity: "Multi-GSTIN entity registration data. Business entity data.",
      GstRegistration: "Individual GSTIN registration details. Business entity data.",
      RcmRegisterEntry: "Reverse charge mechanism register entries. Tax compliance data.",
      GstNotice: "GST notices from tax authorities. Business compliance data.",
      GstNoticeResponse: "Responses to GST notices. Business compliance data.",
      NoticeReconciliationArtifact: "Reconciliation artifacts for GST notices. Tax compliance data.",
      EwayBill: "E-way bill records for goods movement. Business logistics data.",
      GstSupplier: "GST supplier master data. Business vendor data.",
      GstSupplierOnboarding: "Supplier onboarding workflow state. Business process data.",
      GstVendorPortalInvite: "Vendor portal invitation records. Business process data.",
      GstVendorPortalSubmission: "Vendor portal submission records. Business process data.",
      LutApplication:
        "Duty-free (LUT/BOND) applications filed against the book's GSTIN. Statutory export-benefit records, not subject personal data.",
      ShippingBill:
        "Shipping bill records for exports under the book's GSTIN. Customs/tax compliance records, not subject personal data.",
      GstFilingCampaign:
        "GST filing campaign runbook (form type, period, due date, signing method, acknowledgement state) for the book's GSTIN. Tax compliance workflow data, not subject personal data.",

      // Banking / accounting models — hold financial transaction data, not personal data of the subject
      BankFeed: "Bank feed configuration and sync state. Financial institution data.",
      BankTransaction: "Individual bank transactions. Financial transaction data.",
      BankMatchRule: "Rules for matching bank transactions. Configuration data.",
      ExpenseRule: "Rules for expense categorization. Configuration data.",
      AdjustmentJournal: "Adjustment journal entries. Accounting data.",
      AdjustmentJournalLine: "Lines of adjustment journals. Accounting data.",
      BookAuditEntry: "Audit trail entries for books. Accounting audit data.",
      CoaMapping: "Chart of accounts mappings. Accounting configuration data.",
      FixedAsset: "Fixed asset register entries. Asset accounting data.",
      Vehicle: "Vehicle register entries. Asset accounting data.",
      FiscalPeriodLock: "Fiscal period lock records. Business accounting data, not subject personal data.",
      SubledgerPosting: "Subledger posting records. Accounting data, not subject personal data.",
      InventoryItem: "Inventory item master. Stock accounting data.",
      InventoryMovement: "Inventory movement records. Stock accounting data.",

      // Payroll models — hold payroll processing data, not personal data of the subject requesting portability
      PayrollEmployee:
        "Employee master data for payroll processing. Employee data belongs to the employer, not the subject.",
      PayrollSalaryStructure: "Salary structure definitions. Payroll configuration data.",
      PayrollRun: "Payroll run records. Payroll processing data.",
      PayrollRunEmployee: "Employee-specific payroll run data. Payroll processing data.",
      TdsEntry: "TDS entries for payroll. Tax compliance data.",
      ClosingEntry: "Closing entries for period-end. Accounting data.",
      ClosingEntryLine: "Lines of closing entries. Accounting data.",
      CarryForward: "Carry forward entries for new FY. Accounting data.",
      CarryForwardLine: "Lines of carry forward entries. Accounting data.",

      // Statutory compliance models — hold statutory reference data, not personal data
      StatuteSource: "Source documents for statutes. Legal reference data.",
      StatuteNotification: "Statutory notifications. Legal reference data.",
      StatutoryRule: "Extracted statutory rules. Legal reference data.",
      StatutoryRuleVersion: "Versioned statutory rules. Legal reference data.",

      // CA source-ingestion models — client accounting source data the firm was
      // engaged to process, plus firm-level mapping configuration. Same category
      // as the books models above: client data, not the requestor's own data.
      CaSource: "Source-system metadata and its saved column mapping for a client. Firm configuration data.",
      CaMappingProfile: "Reusable column-to-canonical-field mappings for a source system. Firm configuration data.",
      CaIngestRun: "Ingest run bookkeeping (counts, status, report) for a client source. Firm processing metadata.",
      CaDocumentSnapshot:
        "Canonicalised client accounting documents captured from one ingest run. Client data, not the subject's.",
      ClientDocumentRequest:
        "Register of documents the firm has asked a client for (deadline, status, reminder trail). Client engagement data, not the requesting subject's personal data.",
    };

    const covered = new Set([...EXPORT_SECTIONS.flatMap((s) => s.models), ...PROFILE_MODELS]);

    // Every declared model must actually exist — a typo would silently create
    // a permanent hole in the coverage check above.
    for (const model of covered) {
      if (!models.includes(model)) {
        throw new Error(`EXPORT_SECTIONS declares model "${model}", which is not in prisma/schema.prisma.`);
      }
    }

    const uncovered = models.filter(
      (m) => !covered.has(m) && !(m in NO_PERSONAL_DATA) && !NOT_EXPORTED.some((n) => n.model === m),
    );

    if (uncovered.length > 0) {
      throw new Error(
        `Models holding personal data are absent from the portability bundle and not justified: ${uncovered.join(", ")}. ` +
          `Add an EXPORT_SECTIONS entry with a \`models\` array, add the model to PROFILE_MODELS, or record the omission with a reason.`,
      );
    }
    expect(uncovered).toEqual([]);

    // Every justification must actually be written down.
    for (const entry of [...Object.values(NO_PERSONAL_DATA), ...NOT_EXPORTED.map((n) => n.reason)]) {
      if (entry.length < 20) throw new Error(`Justification is too thin to be meaningful: "${entry}"`);
    }
  });

  it("exports nothing when the principal has no workspace", async () => {
    // Regression guard for the cross-tenant leak this file exists to prevent:
    // workspace-scoped sections were originally `workspaceId ? { workspaceId } : {}`,
    // and an empty Prisma `where` matches EVERY row — so a user with no
    // personal workspace would have received the whole installation.
    const owner = await seedUser();
    const workspace = await prisma.workspace.create({
      data: { name: `Privacy WS ${Math.random()}`, user: { connect: { id: owner.id } } },
    });
    await prisma.dataset.create({
      data: {
        workspaceId: workspace.id,
        name: "someone-elses-salary-data",
        originalName: "s.csv",
        mimeType: "text/csv",
        sizeBytes: 1,
        rowCount: 1,
        columnCount: 1,
        ndjsonPath: "x.ndjson",
        columns: "[]",
        createdById: owner.id,
      },
    });

    // A subject with no personal workspace of their own.
    const subject = await seedUser({ workspaceId: null });
    const raw = JSON.stringify(await buildPortabilityBundle(subject.id));

    expect(raw).not.toContain("someone-elses-salary-data");

    const bundle = (await buildPortabilityBundle(subject.id)) as Record<string, any>;
    expect(bundle.datasets).toEqual([]);
    expect(bundle.analyses).toEqual([]);
    expect(bundle.workspace).toEqual([]);
  });
});
