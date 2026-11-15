/**
 * Filing automation decisions — reminder buckets and escalation windows.
 * Pure rules only: no database, no clock, no notifications.
 */

import {
  daysUntil,
  escalationDue,
  escalationMarker,
  reminderKind,
  reminderMarker,
} from "@/lib/server/filing-automation";

describe("filing reminders", () => {
  it("counts whole days between today and the due date", () => {
    expect(daysUntil("2026-11-10", "2026-11-03")).toBe(7);
    expect(daysUntil("2026-11-03", "2026-11-10")).toBe(-7);
    expect(daysUntil("not-a-date", "2026-11-10")).toBeNull();
  });

  it("fires exactly at T-7, T-3 and T-0", () => {
    expect(reminderKind("2026-11-17", "2026-11-10")).toBe("T-7");
    expect(reminderKind("2026-11-13", "2026-11-10")).toBe("T-3");
    expect(reminderKind("2026-11-10", "2026-11-10")).toBe("T-0");
  });

  it("stays quiet on every other day, including after the deadline", () => {
    expect(reminderKind("2026-11-16", "2026-11-10")).toBeNull();
    expect(reminderKind("2026-11-12", "2026-11-10")).toBeNull();
    expect(reminderKind("2026-11-09", "2026-11-10")).toBeNull();
  });

  it("uses one dedupe marker per bucket", () => {
    expect(reminderMarker("T-7")).toBe("reminder:T-7");
    expect(reminderMarker("T-0")).toBe("reminder:T-0");
    expect(escalationMarker("2026-11-10")).toBe("escalated:2026-11-10");
  });
});

describe("filing escalation", () => {
  it("escalates an overdue run that is still open", () => {
    expect(escalationDue("computed", "2026-11-01", "2026-11-10")).toBe(true);
    expect(escalationDue("reviewed", "2026-11-01", "2026-11-10")).toBe(true);
  });

  it("never escalates a run that is filed or acknowledged", () => {
    expect(escalationDue("filed", "2026-11-01", "2026-11-10")).toBe(false);
    expect(escalationDue("acknowledged", "2026-11-01", "2026-11-10")).toBe(false);
  });

  it("does not escalate before the due date", () => {
    expect(escalationDue("computed", "2026-11-10", "2026-11-10")).toBe(false);
    expect(escalationDue("computed", "2026-11-20", "2026-11-10")).toBe(false);
  });
});
