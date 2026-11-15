/**
 * Corporate-compliance operating workflow — oracle tests.
 */

import {
  EntityComplianceError,
  validateEntityMaster,
  entityRegister,
  rocFormsForEvent,
  computeRocDueDate,
  buildEntityFilingCalendar,
  markTaskFiled,
  computeMeetingNotice,
  boardResolutionsForFiling,
  obligationsForEntity,
  documentReadiness,
  attachDocument,
  buildFirmWideCalendar,
  carryForwardEntity,
  ROC_FORM_MAP,
  type EntityMaster,
  type EntityDocument,
  type Resolution,
} from "@/lib/engine/ca-entity-compliance";

function company(over: Partial<EntityMaster> = {}): EntityMaster {
  return {
    entityId: "e1",
    legalName: "Acme Ltd",
    cin: "U74999MH2015PTC123456",
    entityType: "private-limited",
    incorporationDate: "2015-06-01",
    registeredOffice: { line1: "1 Main St", city: "Mumbai", state: "Maharashtra", pincode: "400001" },
    objects: ["Trading"],
    capital: { authorisedMinor: 10_00_000, paidUpMinor: 5_00_000 },
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

describe("validateEntityMaster", () => {
  it("accepts a well-formed private limited company", () => {
    const result = validateEntityMaster(company());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects an invalid CIN, capital inversion, bad DIN and bad pincode", () => {
    const result = validateEntityMaster(
      company({
        cin: "BAD",
        capital: { authorisedMinor: 100, paidUpMinor: 200 },
        directors: [{ name: "X", din: "123", designation: "director", appointedOn: "2015-06-01" }],
        registeredOffice: { line1: "x", city: "y", state: "Maharashtra", pincode: "12" },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("CIN");
    expect(result.errors.join(" ")).toContain("Paid-up capital");
    expect(result.errors.join(" ")).toContain("DIN");
    expect(result.errors.join(" ")).toContain("pincode");
  });

  it("requires an LLPIN for an LLP", () => {
    const result = validateEntityMaster(company({ entityType: "llp", cin: null, llpin: null }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("LLPIN");
  });
});

describe("entityRegister", () => {
  it("summarises the director, shareholder and charge registers", () => {
    const register = entityRegister(
      company({
        directors: [
          { name: "A", din: "01234567", designation: "director", appointedOn: "2015-06-01" },
          { name: "B", din: "07654321", designation: "director", appointedOn: "2016-04-01", resignedOn: "2025-03-31" },
        ],
        charges: [
          { id: "c1", chargeType: "creation", holder: "Bank", amountMinor: 10_00_000, createdOn: "2025-01-01" },
          { id: "c2", chargeType: "satisfaction", holder: "Bank", amountMinor: 4_00_000, createdOn: "2025-06-01" },
        ],
      }),
    );
    expect(register.activeDirectors).toBe(1);
    expect(register.resignedDirectors).toBe(1);
    expect(register.equityShares).toBe(5_000);
    expect(register.charges.creation).toBe(1);
    expect(register.outstandingChargeMinor).toBe(6_00_000);
  });
});

describe("rocFormsForEvent", () => {
  it("maps events to their ROC forms", () => {
    expect(rocFormsForEvent("annual-financial-statements").map((s) => s.form)).toContain("AOC-4");
    expect(rocFormsForEvent("charge-creation").map((s) => s.form)).toContain("CHG-1");
    expect(rocFormsForEvent("board-resolution").map((s) => s.form)).toContain("MGT-14");
    expect(ROC_FORM_MAP.find((s) => s.form === "AOC-4")!.dependsOn).toContain("ADT-1");
  });
});

describe("computeRocDueDate", () => {
  it("applies event-based and AGM-based rules", () => {
    const dir12 = ROC_FORM_MAP.find((s) => s.form === "DIR-12")!;
    expect(computeRocDueDate(dir12, { eventDate: "2026-05-01" })).toBe("2026-05-31");
    const aoc4 = ROC_FORM_MAP.find((s) => s.form === "AOC-4")!;
    expect(computeRocDueDate(aoc4, { agmDate: "2026-06-30" })).toBe("2026-07-30");
  });

  it("applies the annual-fixed DIR-3 KYC deadline using the as-of year", () => {
    const kyc = ROC_FORM_MAP.find((s) => s.form === "DIR-3 KYC")!;
    expect(computeRocDueDate(kyc, { asOf: "2026-07-01" })).toBe("2026-09-30");
  });
});

describe("buildEntityFilingCalendar", () => {
  it("resolves events, due dates and dependency blocks", () => {
    const calendar = buildEntityFilingCalendar({
      entity: company(),
      events: [
        { event: "annual-financial-statements", eventDate: "2026-06-30" },
        { event: "annual-return", eventDate: "2026-06-30" },
        { event: "director-kyc", eventDate: "2026-06-30" },
      ],
      asOf: "2026-07-01",
    });
    const aoc4 = calendar.tasks.find((t) => t.form === "AOC-4")!;
    expect(aoc4.dueDate).toBe("2026-07-30");
    expect(aoc4.blockedBy).toEqual(["ADT-1"]);
    const mgt7 = calendar.tasks.find((t) => t.form === "MGT-7")!;
    expect(mgt7.dueDate).toBe("2026-08-29");
    expect(mgt7.blockedBy).toEqual(["AOC-4"]);
    expect(calendar.dueWithin30Days).toContain("AOC-4");
    expect(calendar.overdue).toHaveLength(0);
    expect(calendar.blockedByDependencies).toEqual(expect.arrayContaining(["AOC-4", "MGT-7"]));
  });

  it("treats an externally-filed dependency as satisfied", () => {
    const calendar = buildEntityFilingCalendar({
      entity: company(),
      events: [{ event: "annual-financial-statements", eventDate: "2026-06-30" }],
      asOf: "2026-07-01",
      requiredForms: ["ADT-1"],
    });
    expect(calendar.tasks.find((t) => t.form === "AOC-4")!.blockedBy).toEqual([]);
  });

  it("substitutes MGT-7A for a one-person company and marks overdue tasks", () => {
    const calendar = buildEntityFilingCalendar({
      entity: company({ entityType: "one-person-company" }),
      events: [{ event: "annual-return", eventDate: "2026-06-30" }],
      asOf: "2026-09-30",
    });
    expect(calendar.tasks.find((t) => t.form === "MGT-7")).toBeUndefined();
    expect(calendar.tasks.some((t) => t.status === "overdue")).toBe(false);
  });

  it("refuses to file a blocked task", () => {
    const calendar = buildEntityFilingCalendar({
      entity: company(),
      events: [{ event: "annual-financial-statements", eventDate: "2026-06-30" }],
      asOf: "2026-07-01",
    });
    const aoc4 = calendar.tasks.find((t) => t.form === "AOC-4")!;
    expect(() => markTaskFiled(aoc4, "2026-07-15", "SRN1")).toThrow(EntityComplianceError);
  });
});

describe("computeMeetingNotice", () => {
  it("passes a board meeting with at least 7 clear days", () => {
    const result = computeMeetingNotice({ type: "board", calledOn: "2026-04-01", meetingDate: "2026-04-10" });
    expect(result.clearDaysAvailable).toBe(8);
    expect(result.valid).toBe(true);
  });

  it("fails an AGM with fewer than 21 clear days", () => {
    const result = computeMeetingNotice({ type: "agm", calledOn: "2026-05-01", meetingDate: "2026-05-21" });
    expect(result.clearDaysAvailable).toBe(19);
    expect(result.valid).toBe(false);
  });

  it("allows a short-notice EGM with 95% consent", () => {
    const short = computeMeetingNotice({ type: "egm", calledOn: "2026-05-01", meetingDate: "2026-05-10" });
    expect(short.valid).toBe(false);
    const withConsent = computeMeetingNotice({
      type: "egm",
      calledOn: "2026-05-01",
      meetingDate: "2026-05-10",
      consentWaiverPct: 95,
    });
    expect(withConsent.valid).toBe(true);
  });
});

describe("boardResolutionsForFiling", () => {
  it("schedules MGT-14 only for passed resolutions that require it", () => {
    const resolutions: Resolution[] = [
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
    ];
    const filings = boardResolutionsForFiling(resolutions);
    expect(filings).toHaveLength(1);
    expect(filings[0]!.dueDate).toBe("2026-05-31");
  });
});

describe("obligationsForEntity", () => {
  it("adds professional tax, shops and labour obligations for a staffed Maharashtra company", () => {
    const obligations = obligationsForEntity(company(), { employsStaff: true });
    const kinds = obligations.map((o) => o.kind);
    expect(kinds).toContain("professional-tax");
    expect(kinds).toContain("shops-establishments");
    expect(kinds.filter((k) => k === "labour-law").length).toBe(2);
  });

  it("adds FEMA reporting for a foreign subsidiary", () => {
    const obligations = obligationsForEntity(company({ entityType: "foreign-subsidiary" }), {
      foreignInvestment: true,
    });
    expect(obligations.some((o) => o.kind === "fema")).toBe(true);
  });
});

describe("document repository", () => {
  it("reports the documents a form still needs", () => {
    const docs: EntityDocument[] = [
      { id: "d1", entityId: "e1", kind: "moa", title: "MOA", version: 1, uploadedAt: "2026-04-01" },
    ];
    const readiness = documentReadiness(docs, ["moa", "aoa", "certificate-of-incorporation"]);
    expect(readiness.complete).toBe(false);
    expect(readiness.missing).toEqual(["aoa", "certificate-of-incorporation"]);
  });

  it("versions an attached document", () => {
    let docs: EntityDocument[] = [];
    docs = attachDocument(docs, {
      id: "d1",
      entityId: "e1",
      kind: "financial-statements",
      title: "FS",
      uploadedAt: "2026-04-01",
    });
    docs = attachDocument(docs, {
      id: "d2",
      entityId: "e1",
      kind: "financial-statements",
      title: "FS revised",
      uploadedAt: "2026-04-10",
    });
    expect(docs[1]!.version).toBe(2);
  });
});

describe("buildFirmWideCalendar", () => {
  it("aggregates tasks and surfaces overdue work across entities", () => {
    const overdueTask = {
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
    const upcomingTask = {
      id: "t2",
      entityId: "e2",
      form: "MGT-7",
      event: "annual-return" as const,
      description: "AR",
      dueDate: "2026-09-01",
      status: "pending" as const,
      dependsOn: [],
      blockedBy: [],
      documentRefs: [],
      filedOn: null,
      srn: null,
    };
    const result = buildFirmWideCalendar(
      [
        { entityId: "e1", entityName: "Acme", tasks: [overdueTask] },
        { entityId: "e2", entityName: "Beta", tasks: [upcomingTask] },
      ],
      "2026-08-25",
    );
    expect(result.totalTasks).toBe(2);
    expect(result.overdue.map((o) => o.form)).toEqual(["AOC-4"]);
    expect(result.dueNext30Days.map((t) => t.form)).toEqual(["MGT-7"]);
    expect(result.byEntity).toEqual({ e1: 1, e2: 1 });
  });
});

describe("carryForwardEntity", () => {
  it("retains the registers and rolls the financial year forward", () => {
    const next = carryForwardEntity(company(), { newFinancialYearEnd: "2027-03-31", lastAgmDate: "2027-06-30" });
    expect(next.financialYearEnd).toBe("2027-03-31");
    expect(next.lastAgmDate).toBe("2027-06-30");
    expect(next.directors).toHaveLength(2);
    expect(next.auditor?.name).toBe("Audit LLP");
  });
});

describe("DIR-6 & AOC-2", () => {
  it("maps a director-particulars change to DIR-6 with a 30-day due date", () => {
    const specs = rocFormsForEvent("director-particulars-change");
    expect(specs.map((s) => s.form)).toContain("DIR-6");
    expect(computeRocDueDate(specs[0]!, { eventDate: "2026-05-01" })).toBe("2026-05-31");
  });

  it("maps a related-party transaction to AOC-2, due 30 days from the AGM", () => {
    const specs = rocFormsForEvent("related-party-transaction");
    expect(specs.map((s) => s.form)).toContain("AOC-2");
    expect(computeRocDueDate(specs[0]!, { agmDate: "2026-06-30" })).toBe("2026-07-30");
    expect(specs[0]!.attachments).toContain("related-party-disclosure");
  });

  it("surfaces DIR-6 and AOC-2 as calendar tasks from their events", () => {
    const calendar = buildEntityFilingCalendar({
      entity: company(),
      events: [
        { event: "director-particulars-change", eventDate: "2026-05-01" },
        { event: "related-party-transaction", eventDate: "2026-06-30" },
      ],
      asOf: "2026-05-10",
    });
    expect(calendar.tasks.find((t) => t.form === "DIR-6")?.dueDate).toBe("2026-05-31");
    expect(calendar.tasks.find((t) => t.form === "AOC-2")?.dueDate).toBe("2026-07-30");
  });
});
