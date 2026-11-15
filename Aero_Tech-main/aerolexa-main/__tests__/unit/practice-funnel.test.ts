/**
 * Practice funnel — hand-pinned stall ladder.
 *
 * Order matters: the first missing step names the next build, so a bug that
 * reports "no reconciliation" on an empty install would send the team to build
 * the wrong thing.
 */

import { practiceStall, type PracticeCounts } from "@/lib/server/practice-funnel";

function counts(overrides: Partial<PracticeCounts> = {}): PracticeCounts {
  return {
    engagements: 3,
    portalAccounts: 2,
    preparedFilings: 5,
    filedFilings: 2,
    reconciledFilings: 1,
    ...overrides,
  };
}

describe("practiceStall", () => {
  it("reports the first missing step, in value-chain order", () => {
    expect(practiceStall(counts({ engagements: 0 })).stage).toBe("no-clients");
    expect(practiceStall(counts({ portalAccounts: 0 })).stage).toBe("no-portal");
    expect(practiceStall(counts({ preparedFilings: 0 })).stage).toBe("no-filings");
    expect(practiceStall(counts({ filedFilings: 0 })).stage).toBe("no-live-filings");
    expect(practiceStall(counts({ reconciledFilings: 0 })).stage).toBe("no-reconciliation");
    expect(practiceStall(counts()).stage).toBe("complete");
  });

  it("an empty install never claims downstream progress", () => {
    const empty = { engagements: 0, portalAccounts: 0, preparedFilings: 0, filedFilings: 0, reconciledFilings: 0 };
    expect(practiceStall(empty).stage).toBe("no-clients");
    expect(practiceStall(empty).nextBuild).toContain("onboarding");
  });

  it("each stage names a different next build", () => {
    const stages = [
      practiceStall(counts({ engagements: 0 })).nextBuild,
      practiceStall(counts({ portalAccounts: 0 })).nextBuild,
      practiceStall(counts({ preparedFilings: 0 })).nextBuild,
      practiceStall(counts({ filedFilings: 0 })).nextBuild,
      practiceStall(counts({ reconciledFilings: 0 })).nextBuild,
      practiceStall(counts()).nextBuild,
    ];
    expect(new Set(stages).size).toBe(stages.length);
  });
});
