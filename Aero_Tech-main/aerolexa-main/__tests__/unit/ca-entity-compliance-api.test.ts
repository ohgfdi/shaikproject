/**
 * Corporate-compliance API adapter — oracle tests.
 *
 * Pins the two things the adapter can get wrong that the engine suite cannot
 * see: the RUPEES → PAISE conversion on the nested `EntityMaster` (capital and
 * charges), and the `op` dispatch/validation.
 */

import {
  EntityComplianceError,
  type EntityFilingCalendar,
  type EntityRegister,
  type FirmWideCalendar,
  type MeetingNoticeResult,
} from "@/lib/engine/ca-entity-compliance";
import { entityComplianceInput, computeEntityCompliance } from "@/lib/engine/ca-entity-compliance-api";

function run(input: unknown) {
  return computeEntityCompliance(entityComplianceInput.parse(input));
}

/** Entity master with RUPEES money fields, as it arrives over the API. */
function master(over: Record<string, unknown> = {}) {
  return {
    entityId: "e1",
    legalName: "Acme Ltd",
    cin: "U74999MH2015PTC123456",
    entityType: "private-limited",
    incorporationDate: "2015-06-01",
    registeredOffice: { line1: "1 Main St", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
    objects: ["Trading"],
    capital: { authorised: 10_000, paidUp: 5_000 },
    directors: [
      { name: "A Director", din: "01234567", designation: "director", appointedOn: "2015-06-01" },
      { name: "B Director", din: "07654321", designation: "director", appointedOn: "2016-04-01" },
    ],
    shareholders: [{ name: "A Director", pan: "ABCDE1234F", shareClass: "equity", shares: 5_000 }],
    charges: [],
    auditor: { name: "Audit LLP", appointedOn: "2025-09-30", termEndsOn: "2030-09-30" },
    financialYearEnd: "2026-03-31",
    lastAgmDate: "2026-06-30",
    ...over,
  };
}

describe("entityComplianceInput validation", () => {
  it("accepts a payload carrying the outer `kind` discriminator", () => {
    expect(
      entityComplianceInput.safeParse({ kind: "entity-compliance", op: "roc-forms", event: "annual-return" }).success,
    ).toBe(true);
  });

  it("rejects an unknown op", () => {
    expect(entityComplianceInput.safeParse({ op: "nope" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    expect(entityComplianceInput.safeParse({ op: "due-date" }).success).toBe(false);
  });
});

describe("entity master validation & registers", () => {
  it("validates a well-formed private limited company", () => {
    const result = run({ op: "validate-master", entity: master() }) as { valid: boolean; errors: string[] };
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects an invalid CIN", () => {
    const result = run({ op: "validate-master", entity: master({ cin: "BAD" }) }) as {
      valid: boolean;
      errors: string[];
    };
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("CIN");
  });

  it("converts capital (rupees) to paise and counts charge exposure", () => {
    // creation ₹10,000 → 1,000,000 paise; satisfaction ₹4,000 → 400,000 paise.
    const register = run({
      op: "register",
      entity: master({
        charges: [
          { id: "c1", chargeType: "creation", holder: "Bank", amount: 10_000, createdOn: "2025-01-01" },
          { id: "c2", chargeType: "satisfaction", holder: "Bank", amount: 4_000, createdOn: "2025-06-01" },
        ],
      }),
    }) as EntityRegister;
    expect(register.equityShares).toBe(5_000);
    expect(register.charges.creation).toBe(1);
    expect(register.outstandingChargeMinor).toBe(600_000);
  });
});

describe("ROC form workflow", () => {
  it("maps events to forms", () => {
    const forms = run({ op: "roc-forms", event: "annual-financial-statements" }) as { form: string }[];
    expect(forms.map((s) => s.form)).toContain("AOC-4");
  });

  it("computes event-, AGM- and annual-fixed due dates", () => {
    expect(
      (run({ op: "due-date", form: "DIR-12", context: { eventDate: "2026-05-01" } }) as { dueDate: string }).dueDate,
    ).toBe("2026-05-31");
    expect(
      (run({ op: "due-date", form: "AOC-4", context: { agmDate: "2026-06-30" } }) as { dueDate: string }).dueDate,
    ).toBe("2026-07-30");
    expect(
      (run({ op: "due-date", form: "DIR-3 KYC", context: { asOf: "2026-07-01" } }) as { dueDate: string }).dueDate,
    ).toBe("2026-09-30");
  });

  it("throws on an unknown form", () => {
    expect(() => run({ op: "due-date", form: "NOPE-1", context: {} })).toThrow(EntityComplianceError);
  });

  it("builds the filing calendar with dependencies", () => {
    const calendar = run({
      op: "filing-calendar",
      entity: master(),
      events: [{ event: "annual-financial-statements", eventDate: "2026-06-30" }],
      asOf: "2026-07-01",
    }) as EntityFilingCalendar;
    const aoc4 = calendar.tasks.find((t) => t.form === "AOC-4")!;
    expect(aoc4.dueDate).toBe("2026-07-30");
    expect(aoc4.blockedBy).toEqual(["ADT-1"]);
    expect(calendar.dueWithin30Days).toContain("AOC-4");
  });

  it("refuses to file a blocked task", () => {
    const calendar = run({
      op: "filing-calendar",
      entity: master(),
      events: [{ event: "annual-financial-statements", eventDate: "2026-06-30" }],
      asOf: "2026-07-01",
    }) as EntityFilingCalendar;
    const aoc4 = calendar.tasks.find((t) => t.form === "AOC-4")!;
    expect(() => run({ op: "mark-filed", task: aoc4, filedOn: "2026-07-15", srn: "SRN1" })).toThrow(
      EntityComplianceError,
    );
  });

  it("surfaces DIR-6 and AOC-2 as calendar tasks", () => {
    const calendar = run({
      op: "filing-calendar",
      entity: master(),
      events: [
        { event: "director-particulars-change", eventDate: "2026-05-01" },
        { event: "related-party-transaction", eventDate: "2026-06-30" },
      ],
      asOf: "2026-05-10",
    }) as EntityFilingCalendar;
    expect(calendar.tasks.find((t) => t.form === "DIR-6")?.dueDate).toBe("2026-05-31");
    expect(calendar.tasks.find((t) => t.form === "AOC-2")?.dueDate).toBe("2026-07-30");
  });
});

describe("meeting mechanics & state/FEMA obligations", () => {
  it("fails an AGM with fewer than 21 clear days and passes an EGM with 95% consent", () => {
    const short = run({
      op: "meeting-notice",
      type: "agm",
      calledOn: "2026-05-01",
      meetingDate: "2026-05-21",
    }) as MeetingNoticeResult;
    expect(short.clearDaysAvailable).toBe(19);
    expect(short.valid).toBe(false);

    const egm = run({
      op: "meeting-notice",
      type: "egm",
      calledOn: "2026-05-01",
      meetingDate: "2026-05-10",
      consentWaiverPct: 95,
    }) as MeetingNoticeResult;
    expect(egm.valid).toBe(true);
  });

  it("schedules MGT-14 filings for passed resolutions only", () => {
    const filings = run({
      op: "resolutions-for-filing",
      resolutions: [
        {
          id: "r1",
          meetingType: "board",
          meetingDate: "2026-05-01",
          subject: "Borrowing",
          voteRequirement: "ordinary",
          passed: true,
          requiresMgst14: true,
        },
        {
          id: "r2",
          meetingType: "board",
          meetingDate: "2026-05-01",
          subject: "Routine",
          voteRequirement: "ordinary",
          passed: true,
          requiresMgst14: false,
        },
      ],
    }) as { dueDate: string }[];
    expect(filings).toHaveLength(1);
    expect(filings[0]!.dueDate).toBe("2026-05-31");
  });

  it("adds professional tax, shops and labour obligations for a staffed Maharashtra company", () => {
    const obligations = run({ op: "obligations", entity: master(), opts: { employsStaff: true } }) as {
      kind: string;
    }[];
    const kinds = obligations.map((o) => o.kind);
    expect(kinds).toContain("professional-tax");
    expect(kinds).toContain("shops-establishments");
    expect(kinds.filter((k) => k === "labour-law").length).toBe(2);
  });

  it("adds FEMA reporting for a foreign subsidiary", () => {
    const obligations = run({
      op: "obligations",
      entity: master({ entityType: "foreign-subsidiary" }),
      opts: { foreignInvestment: true },
    }) as { kind: string }[];
    expect(obligations.some((o) => o.kind === "fema")).toBe(true);
  });
});

describe("document repository, firm calendar & carry-forward", () => {
  it("reports the documents a form still needs and versions attachments", () => {
    const readiness = run({
      op: "document-readiness",
      documents: [{ id: "d1", entityId: "e1", kind: "moa", title: "MOA", version: 1, uploadedAt: "2026-04-01" }],
      requiredKinds: ["moa", "aoa", "certificate-of-incorporation"],
    }) as { complete: boolean; missing: string[] };
    expect(readiness.complete).toBe(false);
    expect(readiness.missing).toEqual(["aoa", "certificate-of-incorporation"]);

    const docs = run({
      op: "attach-document",
      documents: [
        { id: "d1", entityId: "e1", kind: "financial-statements", title: "FS", version: 1, uploadedAt: "2026-04-01" },
      ],
      doc: { id: "d2", entityId: "e1", kind: "financial-statements", title: "FS revised", uploadedAt: "2026-04-10" },
    }) as { version: number }[];
    expect(docs[1]!.version).toBe(2);
  });

  it("rolls every entity into the firm-wide calendar", () => {
    const task = {
      id: "t1",
      entityId: "e1",
      form: "AOC-4",
      event: "annual-financial-statements" as const,
      description: "FS",
      dueDate: "2026-07-30",
      status: "overdue" as const,
      dependsOn: [],
      blockedBy: [],
      documentRefs: [],
      filedOn: null,
      srn: null,
    };
    const result = run({
      op: "firm-calendar",
      entries: [{ entityId: "e1", entityName: "Acme", tasks: [task] }],
      asOf: "2026-08-25",
    }) as FirmWideCalendar;
    expect(result.totalTasks).toBe(1);
    expect(result.overdue.map((o) => o.form)).toEqual(["AOC-4"]);
    expect(result.byEntity).toEqual({ e1: 1 });
  });

  it("carries the master forward, retaining registers and converting new capital", () => {
    const next = run({
      op: "carry-forward",
      entity: master(),
      changes: {
        newFinancialYearEnd: "2027-03-31",
        lastAgmDate: "2027-06-30",
        capital: { authorised: 20_000, paidUp: 10_000 },
      },
    }) as { financialYearEnd: string; lastAgmDate: string; directors: unknown[]; capital: { authorisedMinor: number } };
    expect(next.financialYearEnd).toBe("2027-03-31");
    expect(next.lastAgmDate).toBe("2027-06-30");
    expect(next.directors).toHaveLength(2);
    expect(next.capital.authorisedMinor).toBe(2_000_000);
  });
});
