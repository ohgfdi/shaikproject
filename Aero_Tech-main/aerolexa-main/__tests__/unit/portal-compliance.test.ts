/**
 * The client portal renders the firm's own generated calendar, not a copy.
 * The properties that matter: a missing/malformed profile yields nothing, a
 * filed task disappears, and the list stays bounded and deterministic.
 */

import { buildPortalCompliance } from "@/lib/server/client-portal";

const profile = JSON.stringify({
  entityKind: "company",
  financialYear: "2026-27",
  gstRegistered: true,
  gstFrequency: "monthly",
  tdsDeductor: true,
  taxAuditApplicable: false,
  transferPricingApplicable: false,
  listedCompany: false,
  state: "maharashtra",
  employsStaff: false,
});

const TODAY = "2026-11-11";

describe("portal compliance calendar", () => {
  it("returns generated obligations for a configured client", () => {
    const tasks = buildPortalCompliance({
      profile,
      clientId: "eng-1",
      clientName: "Acme Pvt Ltd",
      statuses: [],
      today: TODAY,
    });
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0]!.dueDate <= tasks[tasks.length - 1]!.dueDate).toBe(true);
    expect(tasks.every((task) => task.state !== "filed" && task.state !== "waived")).toBe(true);
  });

  it("drops a task the firm has already marked filed", () => {
    const all = buildPortalCompliance({
      profile,
      clientId: "eng-1",
      clientName: "Acme Pvt Ltd",
      statuses: [],
      today: TODAY,
    });
    const filed = all[0]!;
    const remaining = buildPortalCompliance({
      profile,
      clientId: "eng-1",
      clientName: "Acme Pvt Ltd",
      statuses: [{ taskId: filed.id, status: "filed" }],
      today: TODAY,
    });
    expect(remaining.some((task) => task.id === filed.id)).toBe(false);
  });

  it("returns nothing when the firm has not confirmed the profile", () => {
    expect(
      buildPortalCompliance({
        profile: null,
        clientId: "eng-1",
        clientName: "Acme Pvt Ltd",
        statuses: [],
        today: TODAY,
      }),
    ).toEqual([]);
    expect(
      buildPortalCompliance({
        profile: "{ not json",
        clientId: "eng-1",
        clientName: "Acme Pvt Ltd",
        statuses: [],
        today: TODAY,
      }),
    ).toEqual([]);
    expect(
      buildPortalCompliance({
        profile: JSON.stringify({ entityKind: "martian", gstFrequency: "monthly" }),
        clientId: "eng-1",
        clientName: "Acme Pvt Ltd",
        statuses: [],
        today: TODAY,
      }),
    ).toEqual([]);
  });

  it("honours the caller's limit", () => {
    const tasks = buildPortalCompliance({
      profile,
      clientId: "eng-1",
      clientName: "Acme Pvt Ltd",
      statuses: [],
      today: TODAY,
      limit: 3,
    });
    expect(tasks).toHaveLength(3);
  });
});
