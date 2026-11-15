/**
 * Partner dashboard maths. Every figure here is a ratio of recorded rows; when
 * the denominator is zero the answer is null (the UI says "not recorded"), never
 * a flattering 0% or 100%.
 */

import {
  deadlineBuckets,
  realisationPct,
  suggestAssignee,
  utilisationPct,
} from "@/lib/server/partner-dashboard";

describe("utilisation", () => {
  it("is billable minutes over recorded minutes, to one decimal", () => {
    expect(utilisationPct(90, 120)).toBe(75);
    expect(utilisationPct(1, 3)).toBe(33.3);
    expect(utilisationPct(2, 3)).toBe(66.7);
  });

  it("is null when no time was recorded, never a made-up number", () => {
    expect(utilisationPct(0, 0)).toBeNull();
    expect(utilisationPct(60, 0)).toBeNull();
  });
});

describe("realisation", () => {
  it("is collected over collected plus outstanding", () => {
    expect(realisationPct(75_000, 25_000)).toBe(75);
    expect(realisationPct(0, 10_000)).toBe(0);
  });

  it("is null when nothing has been invoiced", () => {
    expect(realisationPct(0, 0)).toBeNull();
  });
});

describe("deadline buckets", () => {
  const today = "2026-11-10";
  it("counts overdue, next 7 days and next 30 days without overlap", () => {
    expect(
      deadlineBuckets(
        [
          { dueDate: "2026-11-09", stage: "prepared" },
          { dueDate: "2026-11-10", stage: "computed" },
          { dueDate: "2026-11-17", stage: "reviewed" },
          { dueDate: "2026-11-18", stage: "client-approved" },
          { dueDate: "2026-12-10", stage: "computed" },
          { dueDate: "2026-11-01", stage: "acknowledged" },
        ],
        today,
      ),
    ).toEqual({ overdue: 1, due7: 2, due30: 2 });
  });
});

describe("assignment choice", () => {
  const candidates = [
    { userId: "u-partner", practiceRole: "PARTNER" as const },
    { userId: "u-assistant", practiceRole: "ASSISTANT" as const },
    { userId: "u-manager", practiceRole: "MANAGER" as const },
    { userId: "u-auditor", practiceRole: "AUDITOR" as const },
  ];

  it("picks the least-loaded eligible member", () => {
    expect(
      suggestAssignee(candidates, {
        "u-partner": 5,
        "u-assistant": 2,
        "u-manager": 3,
        "u-auditor": 0,
      }),
    ).toBe("u-assistant");
  });

  it("never assigns to an auditor, even when idle", () => {
    expect(suggestAssignee([{ userId: "u-auditor", practiceRole: "AUDITOR" }], {})).toBeNull();
  });

  it("breaks ties toward the junior role, then deterministically by id", () => {
    expect(
      suggestAssignee(
        [
          { userId: "u-manager", practiceRole: "MANAGER" },
          { userId: "u-assistant", practiceRole: "ASSISTANT" },
        ],
        {},
      ),
    ).toBe("u-assistant");
    expect(
      suggestAssignee(
        [
          { userId: "b", practiceRole: "ASSISTANT" },
          { userId: "a", practiceRole: "ASSISTANT" },
        ],
        {},
      ),
    ).toBe("a");
  });
});
