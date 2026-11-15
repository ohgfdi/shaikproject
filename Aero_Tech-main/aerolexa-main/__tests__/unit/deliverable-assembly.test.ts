/**
 * Deliverable assembly engine — report assembly, placeholder resolution,
 * client/reviewer redaction, certificate wording, working-paper trace and
 * content hashing.
 *
 * Pure-function suite: it imports the engine (which pulls in the Prisma
 * singleton) but never touches the database, so it runs against the migrated
 * SQLite dev database without seeding anything.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";

import type { EngagementReportTemplate, WorkingPaper, WorkingPaperVersion } from "@/generated/prisma/client";
import {
  assemble,
  build44ABCertificateBody,
  build44ADACertificateBody,
  build44ADCertificateBody,
  buildAdvanceTaxCertificateBody,
  buildCertificatePartBody,
  buildMgmtLetterBody,
  hashContent,
  PLACEHOLDER_KEYS,
  renderClauseList,
  renderNotesSkeleton,
  renderTemplate,
  renderTraceabilityStatement,
  renderWorkingPaperTracePart,
  resolvePlaceholders,
  type RenderOptions,
  type WorkingPaperTracePart,
} from "@/lib/engine/deliverable-assembly";
import {
  auditFindingsSummary,
  CLAUSE_LABELS,
  defaultClausesForFormat,
  letterToClientWording,
  MGMT_LETTER_SKELETON,
  NOTES_SKELETON_TITLES,
} from "@/lib/engine/deliverable-coefficients";
import {
  generateUdin,
  generateInternalUdinId,
  INTERNAL_UDIN_TAG,
  isValidUdin,
  udinChecksum,
  recordUdinIssuance,
} from "@/lib/engine/udin";

function template(overrides: Partial<Record<string, unknown>> = {}): EngagementReportTemplate {
  return {
    id: "tpl_test",
    organizationId: "org_test",
    engagementId: "eng_test",
    formatCode: "BALANCE_SHEET",
    masterRef: null,
    label: "Test balance sheet",
    description: null,
    firmName: "^^FIRM_NAME^^",
    firmAddress: "^^FIRM_ADDRESS^^",
    signatoryName: "^^SIGNATORY_NAME^^",
    signatoryDesignation: "^^SIGNATORY_DESIGNATION^^",
    dateLabel: "^^DATE_LABEL^^",
    body: JSON.stringify({
      cover: { title: "Financial Statements of ^^CLIENT_NAME^^", subtitle: "FY 2025-26", docRef: "^^FIRM_NAME^^" },
      parts: [
        { kind: "body", heading: "Statement of Profit and Loss", body: "Revenue as per books of ^^CLIENT_NAME^^." },
        { kind: "note", heading: "Note 1 — Accounting policies", body: "Basis of preparation." },
      ],
      precedents: [],
    }),
    notes: null,
    effectiveFrom: null,
    effectiveTo: null,
    status: "ACTIVE",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  } as EngagementReportTemplate;
}

function tracePart(overrides: Partial<WorkingPaperTracePart> = {}): WorkingPaperTracePart {
  const wp = {
    id: "wp_1",
    organizationId: "org_test",
    engagementId: "eng_test",
    indexRef: "B-200",
    title: "Substantive testing of receivables",
    section: "Receivables",
    saReference: "SA 500",
    status: "reviewed",
    classification: "internal",
    createdById: "user_1",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
  } as unknown as WorkingPaper;
  const latestVersion = {
    id: "wpv_1",
    organizationId: "org_test",
    engagementId: "eng_test",
    workingPaperId: "wp_1",
    version: 2,
    content: JSON.stringify({ changeSummary: "Confirmed two balances with the bank." }),
    preparedById: "abcdef1234567890",
    createdAt: new Date("2026-04-02T00:00:00Z"),
  } as unknown as WorkingPaperVersion;
  const priorVersions = [
    {
      id: "wpv_0",
      organizationId: "org_test",
      engagementId: "eng_test",
      workingPaperId: "wp_1",
      version: 1,
      content: JSON.stringify({ changeSummary: "Initial draft." }),
      preparedById: "abcdef1234567890",
      createdAt: new Date("2026-04-01T00:00:00Z"),
    } as unknown as WorkingPaperVersion,
  ];
  return { wp, latestVersion, priorVersions, ...overrides };
}

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

describe("deliverable placeholder resolution", () => {
  it("substitutes known placeholders in reviewer (non-redacting) mode", () => {
    const out = resolvePlaceholders(
      "Firm: ^^FIRM_NAME^^ — client ^^CLIENT_NAME^^",
      {
        FIRM_NAME: "Acme & Co",
        CLIENT_NAME: "Acme Industries",
      },
      false,
    );
    expect(out).toBe("Firm: Acme & Co — client Acme Industries");
  });

  it("masks sensitive identifiers for the client copy", () => {
    const out = resolvePlaceholders("PAN ^^PAN^^", { PAN: "ABCDE1234F" }, true);
    expect(out).toContain("•••• 234F");
    expect(out).not.toContain("ABCDE1234F");
  });

  it("collapses unresolved tokens to a redaction marker on the client copy", () => {
    const out = resolvePlaceholders("Firm: ^^FIRM_NAME^^", {}, true);
    expect(out).toMatch(/redacted/i);
    expect(out).not.toContain("^^FIRM_NAME^^");
  });

  it("leaves unresolved tokens intact on the reviewer copy", () => {
    expect(resolvePlaceholders("Firm: ^^FIRM_NAME^^", {}, false)).toBe("Firm: ^^FIRM_NAME^^");
  });

  it("scrubs identifiers typed into free text for the client copy", () => {
    const out = resolvePlaceholders("Client GSTIN is 27AAABC1234A1Z5.", {}, true);
    expect(out).not.toContain("27AAABC1234A1Z5");
    expect(out).toContain("•••• A1Z5");
  });

  it("exposes the placeholder catalogue", () => {
    expect(PLACEHOLDER_KEYS).toEqual(expect.arrayContaining(["FIRM_NAME", "CLIENT_NAME", "GSTIN", "PAN", "CIN"]));
  });
});

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe("deliverable template rendering", () => {
  const opts: RenderOptions = {
    variant: "REVIEWER",
    placeholders: { FIRM_NAME: "Acme & Co", CLIENT_NAME: "Acme Industries" },
  };

  it("renders cover, parts and an extra computed body", () => {
    const raw = template().body;
    const result = renderTemplate(raw, { ...opts, extraBody: "Total assets 1,00,000" });
    const kinds = result.parts.map((p) => p.kind);
    expect(kinds).toContain("cover");
    expect(kinds).toContain("body");
    expect(kinds).toContain("extra");
    expect(result.fullBodyMarkdown).toContain("Statement of Profit and Loss");
    expect(result.fullBodyMarkdown).toContain("Total assets 1,00,000");
  });

  it("resolves placeholders per part", () => {
    const result = renderTemplate(template().body, opts);
    expect(result.fullBodyMarkdown).toContain("Acme Industries");
  });

  it("tolerates malformed template JSON without throwing", () => {
    const result = renderTemplate("not-json", { variant: "CLIENT", placeholders: {} });
    expect(result.parts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Clause / notes skeleton
// ---------------------------------------------------------------------------

describe("deliverable clause and notes rendering", () => {
  it("maps each format to its standard clause set", () => {
    expect(defaultClausesForFormat("CERTIFICATE_44AB")).toEqual(["44AB"]);
    expect(defaultClausesForFormat("MGMT_LETTER")).toEqual(expect.arrayContaining(["SA 260", "SA 265"]));
    expect(defaultClausesForFormat("SOMETHING_UNKNOWN")).toEqual(["SA 700"]);
  });

  it("renders declared clause overrides with human labels", () => {
    const out = renderClauseList(JSON.stringify({ "44AB": "Custom 44AB note" }), ["SA 200"]);
    expect(out).toContain("**44AB** — Custom 44AB note");
    expect(out).toContain(CLAUSE_LABELS["SA 200"]);
  });

  it("marks filled notes in the notes skeleton", () => {
    const out = renderNotesSkeleton(JSON.stringify(["Significant accounting policies"]));
    expect(out).toContain("Significant accounting policies ✓ (filled in template)");
    expect(NOTES_SKELETON_TITLES.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Certificate builders
// ---------------------------------------------------------------------------

describe("deliverable certificate builders", () => {
  const opts: RenderOptions = {
    variant: "CLIENT",
    placeholders: {
      FIRM_NAME: "Acme & Co",
      CLIENT_NAME: "Acme Industries",
      ASSESSMENT_YEAR: "2026-27",
      PERIOD_ENDING: "31 March 2026",
      SIGNATORY_NAME: "CA Jane Doe",
    },
  };

  it("builds the 44AB certificate with the statement of facts", () => {
    const out = build44ABCertificateBody(opts, {
      turnoverGross: "2,00,00,000",
      turnoverExempt: "0",
      cashReceipts: "10,00,000",
      bookkeeping: "Yes",
      auditPerformedBy: "Acme & Co",
      auditPerformedFrom: "1 April 2025",
      auditPerformedTo: "31 March 2026",
      notes: ["Maintained proper books."],
    });
    expect(out).toContain("section 44AB");
    expect(out).toContain("Acme Industries");
    expect(out).toContain("2,00,00,000");
    expect(out).toContain("Maintained proper books.");
  });

  it("builds the 44ADA and 44AD certificates", () => {
    const ada = build44ADACertificateBody(opts, {
      grossReceiptsPerBooks: "50,00,000",
      grossReceiptsPerReturn: "50,00,000",
      bankingChannelPct: "95",
      presumptiveIncomeDeclared: "25,00,000",
      expensesClaimedOver80Pct: "No",
      auditPerformedBy: "Acme & Co",
      auditPerformedFrom: "1 April 2025",
      auditPerformedTo: "31 March 2026",
      notes: [],
    });
    expect(ada).toContain("section 44ADA");
    expect(ada).toContain("95%");

    const ad = build44ADCertificateBody(opts, {
      turnoverGross: "80,00,000",
      cashReceipts: "5,00,000",
      bankingChannelPct: "92",
      presumptiveIncomeDeclared: "6,40,000",
      auditPerformedBy: "Acme & Co",
      auditPerformedFrom: "1 April 2025",
      auditPerformedTo: "31 March 2026",
      notes: [],
    });
    expect(ad).toContain("section 44AD");
    expect(ad).toContain("6,40,000");
  });

  it("builds the advance-tax computation with an instalment schedule", () => {
    const out = buildAdvanceTaxCertificateBody(opts, {
      totalIncomeComputed: "10,00,000",
      taxLiabilityTotal: "1,20,000",
      tdsTcsCredit: "20,000",
      advanceTaxPaid: "50,000",
      selfAssessmentTaxPayable: "50,000",
      instalmentDueDates: [
        { dueDate: "15 June 2026", payable: "15,000" },
        { dueDate: "15 September 2026", payable: "30,000" },
      ],
    });
    expect(out).toContain("Advance tax");
    expect(out).toContain("15 September 2026");
    expect(out).toContain("CA Jane Doe");
  });

  it("builds a management letter from findings and suggestions", () => {
    const out = buildMgmtLetterBody(opts, {
      findings: ["Segregation of duties is limited at the cash counter."],
      suggestions: ["Introduce maker-checker for cash disbursements."],
    });
    expect(out).toContain("Segregation of duties is limited at the cash counter.");
    expect(out).toContain("Introduce maker-checker for cash disbursements.");
    expect(MGMT_LETTER_SKELETON.length).toBeGreaterThanOrEqual(4);
  });

  it("summarizes audit findings by severity and tolerates an empty list", () => {
    expect(auditFindingsSummary([])).toMatch(/no observations/i);
    const out = auditFindingsSummary([
      {
        ref: "F-1",
        title: "Related-party disclosure incomplete",
        severity: "material",
        description: "The notes omit two related-party transactions.",
        recommendation: "Include the omitted disclosures.",
        managementResponse: null,
        saRef: "SA 550",
      },
    ]);
    expect(out).toContain("Material — Related-party disclosure incomplete");
    expect(out).toContain("SA 550");
    expect(out).toContain("Not yet provided.");
  });

  it("renders the letter-to-client wording", () => {
    const out = letterToClientWording({
      firmName: "Acme & Co",
      clientName: "Acme Industries",
      engagementName: "Statutory audit FY26",
      periodEnding: "31 March 2026",
      reportDate: "1 June 2026",
      scopeSummary: "We audited the financial statements.",
      reportingFramework: "accrual",
      managementResponsibilities: "Management is responsible.",
      expectedDelivery: "30 June 2026",
    });
    expect(out).toContain("Acme Industries");
    expect(out).toContain("30 June 2026");
  });
});

// ---------------------------------------------------------------------------
// Working-paper traceability
// ---------------------------------------------------------------------------

describe("deliverable working-paper traceability", () => {
  it("shows preparer identity on the reviewer copy only", () => {
    const trace = tracePart();
    const reviewer = renderWorkingPaperTracePart(trace, "REVIEWER", {});
    const client = renderWorkingPaperTracePart(trace, "CLIENT", {});

    expect(reviewer).toContain("Member #");
    expect(reviewer).toContain("Confirmed two balances with the bank.");
    expect(client).toContain("(redacted for client copy)");
    expect(client).not.toContain("Confirmed two balances with the bank.");
  });

  it("lists prior revisions", () => {
    const reviewer = renderWorkingPaperTracePart(tracePart(), "REVIEWER", {});
    expect(reviewer).toContain("Prior revisions (1)");
    expect(reviewer).toContain("Rev 1");
  });

  it("renders a traceability statement listing index refs", () => {
    const out = renderTraceabilityStatement([tracePart()], "CLIENT");
    expect(out).toContain("B-200");
    expect(out).toContain("1 working paper(s)");
  });
});

// ---------------------------------------------------------------------------
// Full assembly + hashing
// ---------------------------------------------------------------------------

describe("deliverable assembly", () => {
  it("hashes deterministically with a d- prefix", () => {
    const a = hashContent("hello world");
    const b = hashContent("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^d-[0-9a-f]{8}$/);
    expect(hashContent("hello world!")).not.toBe(a);
  });

  it("prepends a clause part and appends computed + trace parts", async () => {
    const result = await assemble({
      template: template(),
      computedBody: "Total assets 1,00,000",
      workingPapers: [tracePart()],
      renderOpts: { variant: "CLIENT", placeholders: { CLIENT_NAME: "Acme Industries" } },
    });

    const clausePart = result.parts.find((p) => p.kind === "clauses");
    expect(clausePart).toBeDefined();
    expect(clausePart?.order).toBe(0);
    expect(clausePart?.source).toBe("template");

    expect(result.parts.some((p) => p.source === "computed")).toBe(true);
    const trace = result.parts.find((p) => p.source === "workingPaper");
    expect(trace?.ref).toBe("B-200");

    expect(result.contentHash).toMatch(/^d-/);
    expect(result.fullBodyMarkdown).toContain("Reporting framework and statutory references");
    expect(result.fullBodyMarkdown).toContain("Total assets 1,00,000");
  });

  it("assembles without optional parts", async () => {
    const result = await assemble({
      template: template(),
      renderOpts: { variant: "REVIEWER", placeholders: {} },
    });
    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.contentHash).toMatch(/^d-/);
  });

  it("weaves a certificate part from the dispatcher request", async () => {
    const result = await assemble({
      template: template(),
      renderOpts: {
        variant: "CLIENT",
        placeholders: {
          FIRM_NAME: "Acme & Co",
          CLIENT_NAME: "Acme Industries",
          ASSESSMENT_YEAR: "2026-27",
          PERIOD_ENDING: "31 March 2026",
        },
      },
      certificate: buildCertificatePartBody(
        {
          format: "CERTIFICATE_44AB",
          params: {
            turnoverGross: "2,00,00,000",
            turnoverExempt: "0",
            cashReceipts: "38,00,000",
            bookkeeping: "Electronic",
            auditPerformedBy: "Acme & Co",
            auditPerformedFrom: "1 April 2025",
            auditPerformedTo: "31 March 2026",
            notes: ["Books examined."],
          },
        },
        {
          variant: "CLIENT",
          placeholders: {
            FIRM_NAME: "Acme & Co",
            CLIENT_NAME: "Acme Industries",
            ASSESSMENT_YEAR: "2026-27",
            PERIOD_ENDING: "31 March 2026",
          },
        },
      ),
    });

    const cert = result.parts.find((p) => p.kind === "certificate");
    expect(cert).toBeDefined();
    expect(cert?.heading).toContain("44AB");
    expect(cert?.bodyMarkdown).toContain("section 44AB");
    expect(cert?.source).toBe("computed");
  });

  it("returns null from the dispatcher when no certificate is requested", () => {
    expect(buildCertificatePartBody(undefined, { variant: "CLIENT", placeholders: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UDIN engine
// ---------------------------------------------------------------------------

describe("deliverable UDIN engine", () => {
  it("mints a deterministic 21-character internal tracking id (SHA-256, ICAI-like shape)", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    const a = generateUdin("user_1", "version_1", at);
    const b = generateUdin("user_1", "version_1", at);
    expect(a).toMatch(/^[0-9A-Z]{21}$/);
    expect(a).toBe(b);
  });

  it("changes with the member or issued document", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    expect(generateUdin("user_1", "version_1", at)).not.toBe(generateUdin("user_2", "version_1", at));
    expect(generateUdin("user_1", "version_1", at)).not.toBe(generateUdin("user_1", "version_2", at));
  });

  it("verifies a well-formed value by checksum tail", () => {
    const udin = generateUdin("user_1", "version_1", new Date("2026-06-01T00:00:00Z"));
    expect(isValidUdin(udin)).toBe(true);
    expect(isValidUdin(udin.slice(0, -2) + "AA")).toBe(false);
  });

  it("rejects malformed values outright", () => {
    expect(isValidUdin("")).toBe(false);
    expect(isValidUdin("not-a-udin")).toBe(false);
    expect(isValidUdin("2026" + "123456" + "ABCDEF" + "ZZ")).toBe(false);
  });

  it("checksum tail is two alphabet characters", () => {
    expect(udinChecksum("2026" + "123456" + "ABCDEF")).toMatch(/^[0-9A-Z]{2}$/);
  });

  it("marks internal ids as INTERNAL-UDIN, never as filing UDINs", () => {
    const id = generateInternalUdinId("user_1", "version_1");
    expect(id.kind).toBe(INTERNAL_UDIN_TAG);
    expect(id.value).toMatch(/^[0-9A-Z]{21}$/);
    expect(id.derivation.memberId).toBe("user_1");
    expect(id.derivation.seed).toBe("version_1");
    expect(id.derivation.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("recordUdinIssuance captures a real ICAI-issued UDIN (validated, source-stamped)", () => {
    const at = new Date("2026-06-01T00:00:00Z");
    const realUdin = generateUdin("CA123456", "icai-issued", at);
    const record = recordUdinIssuance({
      udin: realUdin,
      memberId: "CA123456",
      documentDescription: "FY25 audit report — M/s Acme P Ltd",
      documentType: "audit-report",
      issuedAt: at.toISOString(),
      source: "icai-udin-portal",
      notes: "ICAI transaction ref: UDN-2026-001",
      status: "verified",
    });
    expect(record.udin).toBe(realUdin);
    expect(record.source).toBe("icai-udin-portal");
    expect(record.status).toBe("verified");
    expect(record.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.notes).toBe("ICAI transaction ref: UDN-2026-001");
  });

  it("recordUdinIssuance rejects a format-invalid UDIN string", () => {
    expect(() =>
      recordUdinIssuance({
        udin: "not-a-valid-udin-value",
        memberId: "CA123456",
        documentDescription: "x",
        documentType: "audit-report",
        issuedAt: new Date().toISOString(),
        source: "captured-manually",
      }),
    ).toThrow(/Invalid UDIN format/);
  });
});
