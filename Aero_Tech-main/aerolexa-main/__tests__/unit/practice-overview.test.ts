/**
 * Oracle tests for the partner-dashboard health rules.
 *
 * The dashboard's value is the judgement it makes (what needs a partner's
 * attention), so these assert the exact flags, scores and totals rather than
 * snapshotting the shape.
 */

import {
  DRAFT_BACKLOG_THRESHOLD,
  emptyPaperCounts,
  summarisePractice,
  type EngagementHealth,
  type EngagementHealthInput,
} from "@/lib/server/practice-overview";

const NOW = new Date("2026-11-08T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function firstEngagement(engagements: EngagementHealth[]): EngagementHealth {
  const engagement = engagements[0];
  if (!engagement) throw new Error("expected a summarised engagement");
  return engagement;
}

function row(overrides: Partial<EngagementHealthInput> = {}): EngagementHealthInput {
  return {
    id: "e1",
    name: "Acme Manufacturing",
    code: "ACME-FY26",
    status: "ACTIVE",
    jurisdiction: "IN",
    dataClassification: "CONFIDENTIAL",
    legalHold: false,
    retentionUntil: null,
    teamSize: 3,
    papers: { ...emptyPaperCounts(), signedOff: 2, total: 2 },
    deliverablesTotal: 1,
    deliverablesAwaitingReview: 0,
    deliverablesSigned: 1,
    openChanges: 0,
    lastActivityAt: NOW.toISOString(),
    createdAt: new Date(NOW.getTime() - 60 * DAY).toISOString(),
    ...overrides,
  };
}

describe("summarisePractice · health flags", () => {
  it("leaves a fully staffed, clean engagement unflagged and at zero attention", () => {
    const { engagements } = summarisePractice([row()], NOW);
    expect(firstEngagement(engagements).flags).toEqual([]);
    expect(firstEngagement(engagements).attentionScore).toBe(0);
  });

  it("flags review backlog and open changes, weighting them in the score", () => {
    const { engagements } = summarisePractice(
      [
        row({
          papers: { ...emptyPaperCounts(), draft: 1, inReview: 2, total: 3 },
          openChanges: 1,
        }),
      ],
      NOW,
    );
    expect(firstEngagement(engagements).flags).toEqual(["review-backlog", "open-changes"]);
    // 2 in review × 3 + 1 open change × 2 + 1 draft
    expect(firstEngagement(engagements).attentionScore).toBe(9);
  });

  it("treats an active client with nobody assigned as critical", () => {
    const { engagements, totals } = summarisePractice([row({ teamSize: 0 })], NOW);
    expect(firstEngagement(engagements).flags).toContain("no-team");
    expect(firstEngagement(engagements).attentionScore).toBe(5);
    expect(totals.engagementsWithoutTeam).toBe(1);
    expect(totals.needsAttention).toBe(1);
  });

  it("marks a client stale only after the full window, not on the boundary", () => {
    const onBoundary = summarisePractice(
      [row({ lastActivityAt: new Date(NOW.getTime() - 30 * DAY).toISOString() })],
      NOW,
    );
    expect(firstEngagement(onBoundary.engagements).flags).not.toContain("stale");

    const pastBoundary = summarisePractice(
      [row({ lastActivityAt: new Date(NOW.getTime() - 31 * DAY).toISOString() })],
      NOW,
    );
    expect(firstEngagement(pastBoundary.engagements).flags).toContain("stale");
    expect(firstEngagement(pastBoundary.engagements).attentionScore).toBe(4);
    expect(pastBoundary.totals.staleEngagements).toBe(1);
  });

  it("raises a draft backlog at the configured threshold", () => {
    const justUnder = summarisePractice(
      [row({ papers: { ...emptyPaperCounts(), draft: DRAFT_BACKLOG_THRESHOLD - 1, total: 4 } })],
      NOW,
    );
    expect(firstEngagement(justUnder.engagements).flags).not.toContain("draft-backlog");

    const atThreshold = summarisePractice(
      [row({ papers: { ...emptyPaperCounts(), draft: DRAFT_BACKLOG_THRESHOLD, total: 5 } })],
      NOW,
    );
    expect(firstEngagement(atThreshold.engagements).flags).toContain("draft-backlog");
  });

  it("keeps legal hold visible but never counts an archived client as active work", () => {
    const { engagements, totals } = summarisePractice(
      [
        row({ id: "arch", name: "Old Client", status: "ARCHIVED", legalHold: true, teamSize: 0 }),
        row({ id: "live", name: "Live Client" }),
      ],
      NOW,
    );
    const archived = engagements.find((e) => e.id === "arch")!;
    expect(archived.flags).toEqual(["legal-hold"]);
    expect(archived.attentionScore).toBe(0);

    expect(totals.clients).toBe(1);
    expect(totals.archived).toBe(1);
    expect(totals.legalHolds).toBe(1);
    expect(totals.teamAssignments).toBe(3);
    expect(engagements[engagements.length - 1]?.id).toBe("arch");
  });
});

describe("summarisePractice · ordering and totals", () => {
  it("orders by attention score, then client name", () => {
    const { engagements } = summarisePractice(
      [
        row({ id: "clean", name: "Zeta" }),
        row({
          id: "backlog",
          name: "Beta",
          papers: { ...emptyPaperCounts(), inReview: 1, total: 1 },
        }),
        row({ id: "unstaffed", name: "Alpha", teamSize: 0 }),
      ],
      NOW,
    );
    expect(engagements.map((e) => e.id)).toEqual(["unstaffed", "backlog", "clean"]);
  });

  it("rolls paper, deliverable, team and change counts into firm totals", () => {
    const { totals } = summarisePractice(
      [
        row({
          id: "a",
          papers: { ...emptyPaperCounts(), draft: 2, inReview: 1, signedOff: 3, total: 6 },
          deliverablesAwaitingReview: 2,
          deliverablesSigned: 4,
          openChanges: 1,
          teamSize: 2,
        }),
        row({
          id: "b",
          status: "PAUSED",
          papers: { ...emptyPaperCounts(), signedOff: 1, total: 1 },
          deliverablesTotal: 0,
          deliverablesSigned: 0,
          teamSize: 1,
        }),
      ],
      NOW,
    );

    expect(totals).toMatchObject({
      clients: 2,
      active: 1,
      paused: 1,
      archived: 0,
      teamAssignments: 3,
      papersAwaitingReview: 1,
      papersDraft: 2,
      papersSignedOff: 4,
      deliverablesAwaitingReview: 2,
      deliverablesSigned: 4,
      openChanges: 1,
      needsAttention: 1,
    });
  });

  it("returns a stable generatedAt for the same clock", () => {
    const { generatedAt } = summarisePractice([row()], NOW);
    expect(generatedAt).toBe(NOW.toISOString());
  });
});
