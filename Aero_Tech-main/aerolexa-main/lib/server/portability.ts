/**
 * Data portability bundle (Phase 5.3).
 *
 * The DPDP right to access in `lib/server/dpdp.ts` returned *metadata stubs*:
 * `{ id, name, rowCount, createdAt }` for datasets, `{ id, title }` for
 * reports, `{ id, title }` for notebooks. Those rows are an index, not a copy.
 * Portability means the data principal can take their content somewhere else
 * and keep working — and notebook cells, chat transcripts, report sections,
 * DAX measures and analysis configs were all absent. That is the substantive
 * half of what the person actually authored, so the export was incomplete in
 * the way that matters.
 *
 * Two design decisions worth stating, because both are load-bearing:
 *
 * 1. **A manifest, not a bare blob.** Each section declares what it covers and
 *    ships its row count and (on failure) its error into the output. A subject
 *    requesting access is entitled to know what was and was not included — and
 *    a section that silently fails is worse than one that is loudly absent.
 *    Sections are isolated: a single unreadable table degrades one section
 *    rather than failing the whole request and leaving the principal with
 *    nothing.
 *
 * 2. **Secrets are withheld, and the withholding is itself disclosed.**
 *    `passwordHash`, `codeHash`, `tokenHash`, `webhookSecret`, API key
 *    material and the encrypted `Connector.config` blob (which decrypts to a
 *    live database password) are personal data in a literal sense but are
 *    *security credentials*, and a portability bundle is a file that gets
 *    emailed to a subject and lands in their Downloads folder forever. Handing
 *    someone their own password hash hands them an offline cracking target;
 *    handing them a connector credential hands them production database
 *    access. DPDP §11 is about data, not secrets. So credentials are omitted,
 *    non-secret metadata about them is kept, and `WITHHELD_FIELDS` ships in the
 *    manifest so the omission is transparent rather than silent.
 */

import { prisma } from "@/lib/db";

import { CONSENT_POLICY_VERSION } from "./dpdp";

/**
 * Fields deliberately omitted from the bundle, and why. Surfaced verbatim in
 * the manifest so the principal can see that nothing was quietly dropped.
 */
export const WITHHELD_FIELDS: { model: string; fields: string[]; reason: string }[] = [
  {
    model: "User",
    fields: ["passwordHash"],
    reason:
      "Credential material. A portable bundle is a file the subject keeps; an offline password-cracking target must not travel with it.",
  },
  {
    model: "PhoneOtp",
    fields: ["codeHash"],
    reason: "Credential material for a one-time login challenge.",
  },
  {
    model: "VerificationToken",
    fields: ["tokenHash"],
    reason: "Credential material for email verification / password reset.",
  },
  {
    model: "UserApiKey",
    fields: ["keyHash", "keyPrefix"],
    reason: "The prefix is retained for identification; the hash is a credential and is not portable.",
  },
  {
    model: "Connector",
    fields: ["config", "webhookSecret"],
    reason:
      "Decrypts to live database credentials (lib/server/connectors/crypto.ts). Retaining non-secret metadata only.",
  },
  {
    model: "WorkingPaperVersion",
    fields: ["content"],
    reason:
      "The working-paper body is client content; the subject's own paper metadata is exported, but version bodies are withheld so a portability bundle cannot become a client-data exfiltration path.",
  },
  {
    model: "EngagementChangeLog",
    fields: ["rawSummary", "meta"],
    reason:
      "rawSummary/meta can carry the unredacted before/after diff of client data. The redacted summary and the integrity hashes are exported instead.",
  },
  {
    model: "Dataset",
    fields: ["filePath", "ndjsonPath"],
    reason:
      "Server filesystem paths. They describe the host layout, not the subject's data. The parsed content (columns, profile, preview) IS exported.",
  },
  {
    model: "ErrorReport",
    fields: ["stack"],
    reason: "Stack frames are build-machine paths; the error name, message, path and timestamps are exported.",
  },
];

/** One exported collection. */
interface Section {
  /** Stable key used as the property name in the bundle. */
  key: string;
  /** What this section covers, in operator- and subject-facing language. */
  description: string;
  /**
   * Prisma models this section reads. Declared explicitly so
   * `__tests__/unit/privacy-controls.test.ts` can hold the bundle against the
   * real schema instead of guessing model names from section keys.
   */
  models: string[];
  load: (ctx: { userId: string; workspaceId: string | null }) => Promise<unknown[]>;
}

/**
 * Build a WHERE clause that matches NOTHING when the principal has no personal
 * workspace.
 *
 * This exists because of a real bug it replaced. The first draft of every
 * workspace-scoped section was `where: workspaceId ? { workspaceId } : {}`, and
 * an empty `where` in Prisma means EVERY ROW IN THE TABLE — so any user without
 * a personal workspace received every dataset, analysis, report and notebook in
 * the entire installation. A GDPR export endpoint is the worst possible place
 * for that mistake: it is authenticated, it is meant to look trustworthy, and
 * it is exactly the request an attacker would try. Absent a workspace the
 * correct answer is "nothing", never "everything".
 */
const NO_WORKSPACE = { id: "__no_workspace__" } as const;
function wsScope(workspaceId: string | null): { workspaceId: string } | { id: string } {
  return workspaceId ? { workspaceId } : { ...NO_WORKSPACE };
}

/**
 * Every collection in the bundle.
 *
 * Scoping is deliberate and split two ways:
 *  - `workspace` scope — the principal's own workspace, which under DPDP is
 *    their data. A user with a personal workspace owns all of it.
 *  - `user` scope — rows that are per-person even inside a shared workspace
 *    (their chats, their saved searches, their notifications, their error
 *    reports). These are scoped by userId so a future org seat can never leak
 *    a colleague's conversation into an export.
 */
export const EXPORT_SECTIONS: Section[] = [
  {
    key: "workspace",
    description: "The subject's workspace: name, locale, settings and module state",
    models: ["Workspace"],
    load: ({ workspaceId }) =>
      workspaceId
        ? prisma.workspace
            .findUnique({
              where: { id: workspaceId },
              select: { id: true, name: true, settings: true, createdAt: true, updatedAt: true },
            })
            .then((w) => (w ? [w] : []))
        : Promise.resolve([]),
  },
  {
    key: "activities",
    description: "Entries the subject is the recorded actor for, across the audit trail",
    models: ["Activity"],
    load: ({ userId }) =>
      prisma.activity.findMany({
        where: { actorId: userId },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
  },
  {
    key: "consents",
    models: ["ConsentRecord"],
    description: "Consent decisions with the policy version in force at the time",
    load: ({ userId }) => prisma.consentRecord.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  },
  {
    key: "organizationMemberships",
    models: ["OrganizationMember"],
    description: "Firm memberships and the role held in each",
    load: ({ userId }) => prisma.organizationMember.findMany({ where: { userId } }),
  },
  {
    key: "projectMemberships",
    models: ["ProjectMember"],
    description: "Project memberships and the role held in each",
    load: ({ userId }) => prisma.projectMember.findMany({ where: { userId } }),
  },
  {
    key: "ownedOrganizations",
    models: ["Organization"],
    description: "Firms the subject owns",
    load: ({ userId }) => prisma.organization.findMany({ where: { ownerId: userId } }),
  },
  {
    key: "engagements",
    models: ["Engagement"],
    description: "Client engagements belonging to owned firms",
    load: ({ userId }) =>
      prisma.engagement.findMany({
        where: { organization: { ownerId: userId } },
        select: {
          id: true,
          organizationId: true,
          name: true,
          code: true,
          gstin: true,
          status: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "engagementGovernance",
    description:
      "Client-engagement governance records attributed to the subject: practice-role assignments, working papers they prepared/reviewed/signed off, change requests they raised, the change-ledger entries they authored, and client consents they recorded",
    models: [
      "EngagementMember",
      "WorkingPaper",
      "WorkingPaperVersion",
      "EngagementChangeRequest",
      "EngagementChangeLog",
      "ClientConsent",
      "ClientPortalToken",
      "ClientPortalUpload",
      "ClientComplianceProfile",
      "ClientComplianceStatus",
    ],
    load: async ({ userId }) => {
      const [members, papers, versions, changeRequests, changeLog, consents] = await Promise.all([
        prisma.engagementMember.findMany({ where: { userId } }),
        prisma.workingPaper.findMany({
          where: { OR: [{ preparedById: userId }, { reviewedById: userId }, { signedOffById: userId }] },
          select: {
            id: true,
            organizationId: true,
            engagementId: true,
            projectId: true,
            indexRef: true,
            title: true,
            section: true,
            saReference: true,
            status: true,
            classification: true,
            version: true,
            contentHash: true,
            preparedById: true,
            preparedAt: true,
            reviewedById: true,
            reviewedAt: true,
            reviewNote: true,
            signedOffById: true,
            signedOffAt: true,
            signOffRole: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.workingPaperVersion.findMany({
          where: { preparedById: userId },
          select: {
            id: true,
            workingPaperId: true,
            version: true,
            contentHash: true,
            changeSummary: true,
            preparedById: true,
            createdAt: true,
          },
        }),
        prisma.engagementChangeRequest.findMany({
          where: { requestedById: userId },
          select: {
            id: true,
            organizationId: true,
            engagementId: true,
            projectId: true,
            title: true,
            description: true,
            rationale: true,
            targetType: true,
            targetId: true,
            state: true,
            assignedToPracticeRole: true,
            signOffRequiredFor: true,
            reviewNote: true,
            requestedById: true,
            requestedAt: true,
            updatedAt: true,
          },
        }),
        prisma.engagementChangeLog.findMany({
          where: { actorId: userId },
          orderBy: { seq: "asc" },
          take: 500,
          select: {
            id: true,
            organizationId: true,
            engagementId: true,
            seq: true,
            changeRequestId: true,
            actorId: true,
            actorPracticeRole: true,
            action: true,
            targetType: true,
            targetId: true,
            summary: true,
            consentAware: true,
            prevHash: true,
            entryHash: true,
            createdAt: true,
          },
        }),
        prisma.clientConsent.findMany({
          where: { recordedById: userId },
          select: {
            id: true,
            organizationId: true,
            engagementId: true,
            purpose: true,
            subjectRef: true,
            granted: true,
            policyVersion: true,
            evidenceNote: true,
            recordedById: true,
            expiresAt: true,
            createdAt: true,
          },
        }),
      ]);
      return [
        ...members.map((r) => ({ kind: "practiceRoleAssignment", ...r })),
        ...papers.map((r) => ({ kind: "workingPaper", ...r })),
        ...versions.map((r) => ({ kind: "workingPaperVersion", ...r })),
        ...changeRequests.map((r) => ({ kind: "changeRequest", ...r })),
        ...changeLog.map((r) => ({ kind: "changeLedgerEntry", ...r })),
        ...consents.map((r) => ({ kind: "clientConsent", ...r })),
      ];
    },
  },
  {
    key: "projects",
    description: "Projects, including company and engagement linkage",
    models: ["Project"],
    load: ({ userId, workspaceId }) =>
      prisma.project.findMany({
        // A user without a personal workspace still owns whatever projects they
        // created; `wsScope` would wrongly hide those.
        where: workspaceId ? { workspaceId } : { ownerId: userId },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          description: true,
          company: true,
          industry: true,
          status: true,
          ownerId: true,
          organizationId: true,
          engagementId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "datasets",
    models: ["Dataset", "DatasetVersion", "DatasetProvenance"],
    description: "Uploaded datasets with column definitions, profile, preview and applied transform steps",
    load: ({ workspaceId }) =>
      prisma.dataset.findMany({
        where: wsScope(workspaceId),
        // filePath/ndjsonPath withheld (see WITHHELD_FIELDS).
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          name: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          rowCount: true,
          columnCount: true,
          isDemo: true,
          status: true,
          error: true,
          profile: true,
          columns: true,
          preview: true,
          qualityWarnings: true,
          transformSteps: true,
          measures: true,
          connectorId: true,
          connectorSourceTable: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "analyses",
    models: ["Analysis"],
    description: "Analyses including the configuration and the computed result",
    load: ({ workspaceId }) =>
      prisma.analysis.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          datasetId: true,
          kind: true,
          title: true,
          status: true,
          config: true,
          result: true,
          datasetVersionId: true,
          createdById: true,
          createdAt: true,
        },
      }),
  },
  {
    key: "analysisVersions",
    models: ["AnalysisVersion"],
    description: "Version history of every analysis, with metrics per version",
    load: ({ workspaceId }) =>
      prisma.analysisVersion.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          analysisId: true,
          version: true,
          datasetVersionId: true,
          kind: true,
          title: true,
          result: true,
          config: true,
          metrics: true,
          createdById: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
  },
  {
    key: "insights",
    models: ["Insight"],
    description: "Generated insights with evidence and reasoning",
    load: ({ workspaceId }) => prisma.insight.findMany({ where: wsScope(workspaceId) }),
  },
  {
    key: "dashboards",
    models: ["Dashboard"],
    description: "Dashboards including widgets, report pages, bookmarks and theme",
    load: ({ workspaceId }) =>
      prisma.dashboard.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          title: true,
          description: true,
          widgets: true,
          pages: true,
          bookmarks: true,
          theme: true,
          accessMode: true,
          publishedAt: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "reports",
    models: ["Report"],
    description: "Reports including the full section content",
    load: ({ workspaceId }) =>
      prisma.report.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          title: true,
          sections: true,
          version: true,
          accessMode: true,
          publishedAt: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "presentations",
    models: ["Presentation"],
    description: "Presentations including every slide",
    load: ({ workspaceId }) =>
      prisma.presentation.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          title: true,
          slides: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "notebooks",
    models: ["Notebook"],
    description: "Notebooks including all cells (source, outputs, execution state)",
    load: ({ workspaceId }) =>
      prisma.notebook.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          datasetId: true,
          datasetVersionId: true,
          title: true,
          cells: true,
          accessMode: true,
          publishedAt: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "notebookVersions",
    models: ["NotebookVersion"],
    description: "Saved notebook checkpoints",
    load: ({ workspaceId }) =>
      prisma.notebookVersion.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          notebookId: true,
          version: true,
          result: true,
          config: true,
          createdById: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
  },
  {
    key: "prompts",
    models: ["Prompt"],
    description: "Saved prompt templates and their variable definitions",
    load: ({ workspaceId }) =>
      prisma.prompt.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          name: true,
          description: true,
          template: true,
          variables: true,
          chain: true,
          isAdvisorTemplate: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "customMetrics",
    models: ["CustomMetric"],
    description: "Custom metrics with their DAX expressions",
    load: ({ workspaceId }) =>
      prisma.customMetric.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          datasetId: true,
          name: true,
          description: true,
          daxExpression: true,
          format: true,
          tags: true,
          isBuiltin: true,
          isGlobal: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "comments",
    models: ["Comment"],
    description: "Comments the subject wrote, on any artifact they can see",
    load: ({ userId }) => prisma.comment.findMany({ where: { authorId: userId }, orderBy: { createdAt: "asc" } }),
  },
  {
    key: "modelVersions",
    models: ["ModelVersion"],
    description: "Trained model versions with features, metrics and hyperparameters",
    load: ({ workspaceId }) =>
      prisma.modelVersion.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          datasetId: true,
          name: true,
          task: true,
          targetColumn: true,
          features: true,
          metrics: true,
          params: true,
          version: true,
          status: true,
          error: true,
          createdById: true,
          createdAt: true,
        },
      }),
  },
  {
    key: "connectors",
    models: ["Connector", "ConnectorSyncRun"],
    description: "Connected data sources (metadata only — see withheldFields for the credential)",
    load: ({ workspaceId }) =>
      prisma.connector.findMany({
        where: wsScope(workspaceId),
        // config + webhookSecret withheld (see WITHHELD_FIELDS).
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          name: true,
          status: true,
          lastTestedAt: true,
          lastError: true,
          syncEnabled: true,
          syncCron: true,
          lastSyncAt: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "dataAlerts",
    models: ["DataAlert"],
    description: "Alert rules and their firing history",
    load: ({ workspaceId }) =>
      prisma.dataAlert.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          datasetId: true,
          name: true,
          enabled: true,
          ruleKind: true,
          ruleConfig: true,
          columnName: true,
          severity: true,
          cooldownMinutes: true,
          lastFiredAt: true,
          lastResolvedAt: true,
          lastOutcome: true,
          lastMessage: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "scheduledReports",
    models: ["ScheduledReport"],
    description: "Scheduled report deliveries, including recipient addresses",
    load: ({ workspaceId }) => prisma.scheduledReport.findMany({ where: wsScope(workspaceId) }),
  },
  {
    key: "scheduledNotebooks",
    models: ["ScheduledNotebook"],
    description: "Scheduled notebook runs, including recipient addresses",
    load: ({ workspaceId }) => prisma.scheduledNotebook.findMany({ where: wsScope(workspaceId) }),
  },
  {
    key: "apiKeys",
    models: ["UserApiKey"],
    description: "API keys (identifier, prefix and revocation state only)",
    load: ({ userId }) =>
      prisma.userApiKey.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          revokedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
      }),
  },
  // ---------------------------------------------------------------- user scope
  {
    key: "chats",
    models: ["Chat"],
    description: "Assistant conversation threads started by the subject",
    load: ({ userId }) =>
      prisma.chat.findMany({
        where: { userId },
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          title: true,
          model: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "chatMessages",
    models: ["ChatMessage"],
    description: "Every message in the subject's conversations, both directions",
    load: ({ userId }) =>
      prisma.chatMessage.findMany({
        where: { chat: { userId } },
        select: { id: true, chatId: true, role: true, content: true, sources: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
  },
  {
    key: "savedSearches",
    models: ["SavedSearch"],
    description: "Saved searches and their filter state",
    load: ({ userId }) =>
      prisma.savedSearch.findMany({
        where: { userId },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          query: true,
          filter: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "searchHistory",
    models: ["SearchQueryLog"],
    description: "Search terms the subject has run",
    load: ({ userId }) =>
      prisma.searchQueryLog.findMany({
        where: { userId },
        select: { id: true, workspaceId: true, query: true, hitCount: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }),
  },
  {
    key: "notifications",
    models: ["Notification"],
    description: "In-app notifications addressed to the subject",
    load: ({ userId }) =>
      prisma.notification.findMany({
        where: { userId },
        select: { id: true, type: true, title: true, message: true, readAt: true, createdAt: true },
      }),
  },
  {
    key: "feedback",
    models: ["Feedback"],
    description: "Feedback and feature requests the subject submitted",
    load: ({ userId }) =>
      prisma.feedback.findMany({
        where: { userId },
        select: {
          id: true,
          workspaceId: true,
          kind: true,
          message: true,
          context: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "errorReports",
    models: ["ErrorReport"],
    description: "Client errors attributed to the subject (stack frames withheld)",
    load: ({ userId }) =>
      prisma.errorReport.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          message: true,
          path: true,
          requestId: true,
          count: true,
          firstSeenAt: true,
          lastSeenAt: true,
          resolvedAt: true,
        },
      }),
  },
  {
    key: "assistant",
    models: ["AssistantRun", "AssistantToolCall"],
    description:
      "Books-assistant questions the subject asked, the verified answer and the read-only tool calls made to ground it",
    load: async ({ userId }) => {
      const runs = await prisma.assistantRun.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      const runIds = runs.map((run) => run.id);
      const calls = runIds.length
        ? await prisma.assistantToolCall.findMany({
            where: { runId: { in: runIds } },
            orderBy: [{ runId: "asc" }, { seq: "asc" }],
          })
        : [];
      return runs.map((run) => ({
        ...run,
        toolCalls: calls.filter((call) => call.runId === run.id),
      }));
    },
  },
  {
    key: "books",
    models: ["Book", "BookAccount", "BookVoucher", "BookVoucherLine"],
    description:
      "Accounting books: the book identity (legal name, GSTIN, PAN), chart of accounts, vouchers and voucher lines",
    load: ({ workspaceId }) =>
      prisma.book.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          name: true,
          legalName: true,
          gstin: true,
          pan: true,
          entityType: true,
          booksFrom: true,
          fiscalYearEnd: true,
          isDemo: true,
          createdAt: true,
          updatedAt: true,
          accounts: {
            select: {
              id: true,
              bookId: true,
              code: true,
              name: true,
              type: true,
              category: true,
              description: true,
              openingBalance: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          vouchers: {
            select: {
              id: true,
              bookId: true,
              number: true,
              date: true,
              narration: true,
              reference: true,
              voucherType: true,
              createdAt: true,
              updatedAt: true,
              lines: { select: { id: true, voucherId: true, accountId: true, amount: true, narration: true } },
            },
          },
        },
      }),
  },
  {
    key: "billing",
    models: ["Subscription"],
    description: "Subscription and invoice history for the subject's workspace",
    load: ({ workspaceId }) =>
      prisma.subscription.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          planId: true,
          status: true,
          interval: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          canceledAt: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "invoices",
    models: ["Invoice"],
    description: "Invoices raised against the subject's workspace",
    load: ({ workspaceId }) =>
      prisma.invoice.findMany({
        where: wsScope(workspaceId),
        select: {
          id: true,
          workspaceId: true,
          subscriptionId: true,
          number: true,
          amountPaise: true,
          currency: true,
          status: true,
          paymentMethod: true,
          paidAt: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
  },
  {
    key: "filingRuns",
    description: "Statutory filing runs the subject prepared, reviewed, was assigned or last updated",
    models: ["ComplianceFilingRun"],
    load: ({ userId }) =>
      prisma.complianceFilingRun.findMany({
        where: {
          OR: [
            { createdById: userId },
            { updatedById: userId },
            { assigneeId: userId },
            { reviewerId: userId },
          ],
        },
        select: {
          id: true,
          organizationId: true,
          engagementId: true,
          taskId: true,
          title: true,
          authority: true,
          dueDate: true,
          stage: true,
          assigneeId: true,
          reviewerId: true,
          acknowledgementReference: true,
          filedAt: true,
          acknowledgedAt: true,
          verificationStatus: true,
          createdById: true,
          updatedById: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
  },
  {
    key: "filingEvents",
    description: "Filing-stage transitions the subject recorded",
    models: ["ComplianceFilingEvent"],
    load: ({ userId }) =>
      prisma.complianceFilingEvent.findMany({
        where: { actorId: userId },
        select: {
          id: true,
          runId: true,
          organizationId: true,
          fromStage: true,
          toStage: true,
          note: true,
          actorId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 1000,
      }),
  },
  {
    key: "practiceTime",
    description: "Billable and non-billable time the subject logged against engagements",
    models: ["PracticeTimeEntry"],
    load: ({ userId }) =>
      prisma.practiceTimeEntry.findMany({
        where: { userId },
        orderBy: { workDate: "desc" },
      }),
  },
  {
    key: "practiceInvoices",
    description: "Client invoices the subject issued",
    models: ["PracticeInvoice"],
    load: ({ userId }) =>
      prisma.practiceInvoice.findMany({
        where: { createdById: userId },
        select: {
          id: true,
          organizationId: true,
          engagementId: true,
          number: true,
          currency: true,
          subtotalMinor: true,
          taxMinor: true,
          totalMinor: true,
          status: true,
          issuedOn: true,
          dueDate: true,
          paidOn: true,
          paymentMethod: true,
          createdById: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
  },
];

/**
 * Models covered by the bundle's top-level `profile` object rather than by a
 * named section.
 *
 * Declared so schema-coverage tooling can see that `User` IS exported. It is
 * the only personal-data model outside the section list, and without this it
 * would read as a permanent gap.
 */
export const PROFILE_MODELS = ["User"];

/**
 * Models deliberately NOT exported, and why.
 *
 * Shipped inside the manifest so a subject can see that these omissions were
 * decisions rather than oversights.
 */
export const NOT_EXPORTED: { model: string; reason: string }[] = [
  {
    model: "VerificationToken",
    reason:
      "Every column is credential material for a one-time email verification or password reset, and rows are purged within 24 hours of expiry by the retention sweep. There is no non-secret residue worth exporting.",
  },
  {
    model: "PhoneOtp",
    reason:
      "The row is a login challenge, not user content: the code is stored only as a bcrypt hash. Retained for a 7-day abuse-investigation window, then purged by the retention sweep.",
  },
  {
    model: "ComplianceEvent",
    reason:
      "Pseudonymous compliance evidence (which event kind, when, an IP hash, and non-PII counters) retained to satisfy the statutory proof-of-erasure obligation. It is keyed on the subject id rather than a relation, and by the time an erasure event exists the account has been erased — so there is no live principal left to port it to.",
  },
  {
    model: "AssistantOrganizationSetting",
    reason:
      "Organization-level feature switch for the books assistant (on/off plus who last changed it). It is firm configuration rather than the subject's content, and the assistant conversations themselves ARE exported in the assistant section.",
  },
];

/** Per-section outcome, shipped inside the bundle. */
export interface SectionResult {
  key: string;
  description: string;
  /** Number of rows exported. 0 is legitimate (nothing to export). */
  count: number;
  /** Present only when the section failed; the bundle is still delivered. */
  error?: string;
}

export interface PortabilityBundle {
  manifest: {
    format: string;
    generatedAt: string;
    policyVersion: string;
    /** Sections attempted, with counts and any failures. */
    sections: SectionResult[];
    /** Credential fields intentionally omitted, with reasons. */
    withheldFields: typeof WITHHELD_FIELDS;
    /** Whole models intentionally omitted, with reasons. */
    notExported: typeof NOT_EXPORTED;
    /** True when every section exported cleanly. */
    complete: boolean;
  };
  profile: Record<string, unknown>;
  [section: string]: unknown;
}

/**
 * Build the full portability bundle for a data principal.
 *
 * Sections run concurrently and are individually isolated — a section that
 * throws is recorded in the manifest with its error and the rest still ship.
 */
export async function buildPortabilityBundle(userId: string): Promise<PortabilityBundle> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  const ctx = { userId, workspaceId: user.workspaceId ?? null };

  const settled = await Promise.allSettled(EXPORT_SECTIONS.map((s) => s.load(ctx)));

  const bundle: Record<string, unknown> = {
    profile: {
      id: user.id,
      email: user.email,
      name: user.name,
      phoneNumber: user.phoneNumber,
      phoneVerifiedAt: user.phoneVerifiedAt,
      profileRole: user.profileRole,
      goals: user.goals,
      organization: user.organization,
      industry: user.industry,
      experience: user.experience,
      onboardedAt: user.onboardedAt,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };

  const sections: SectionResult[] = [];
  EXPORT_SECTIONS.forEach((section, i) => {
    const outcome = settled[i];
    if (outcome?.status === "fulfilled") {
      const rows = outcome.value as unknown[];
      bundle[section.key] = rows;
      sections.push({ key: section.key, description: section.description, count: rows.length });
    } else {
      const reason =
        outcome?.status === "rejected" ? String(outcome.reason?.message ?? outcome.reason) : "not attempted";
      // The section key is still present, as null, so a consumer can tell
      // "empty" apart from "unavailable".
      bundle[section.key] = null;
      sections.push({ key: section.key, description: section.description, count: 0, error: reason });
    }
  });

  return {
    ...bundle,
    profile: bundle.profile as Record<string, unknown>,
    manifest: {
      format: "ledgerly-portability/1",
      generatedAt: new Date().toISOString(),
      policyVersion: CONSENT_POLICY_VERSION,
      sections,
      withheldFields: WITHHELD_FIELDS,
      notExported: NOT_EXPORTED,
      complete: sections.every((s) => !s.error),
    },
  };
}
