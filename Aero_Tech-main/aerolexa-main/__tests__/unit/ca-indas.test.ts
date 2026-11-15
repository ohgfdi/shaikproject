/**
 * Ind AS judgment-register engine — oracle tests.
 *
 * The engine merges the caller's judgments into the standing key-judgment list,
 * OR-ing the estimation-uncertainty flag for overlapping areas and keeping the
 * standing description. The tests pin that merge behaviour, the applicability
 * note, the transition scaffold and the disclosure checklist.
 */

import { buildIndAsJudgmentRegister } from "@/lib/engine/ca-indas";

const base = {
  fy: "2025-26",
  indAsApplicable: true,
  standards: ["Ind AS 115", "Ind AS 116"],
  judgments: [{ area: "Custom area", description: "Group-specific policy", estimationUncertainty: false }],
  transition: { date: "2025-04-01", method: "full retrospective", openingAdjustment: 12_345 },
};

describe("buildIndAsJudgmentRegister: applicability and standards", () => {
  it("states applicability and maps the supplied standards", () => {
    const res = buildIndAsJudgmentRegister(base);

    expect(res.fy).toBe("2025-26");
    expect(res.indAsApplicable).toBe(true);
    expect(res.applicability.note).toContain("Ind AS is applicable");
    expect(res.applicability.threshold).toBeTruthy();
    expect(res.standards).toEqual([
      {
        standard: "Ind AS 115",
        note: "Reviewer to confirm the current scope and requirements of Ind AS 115 for the FY.",
      },
      {
        standard: "Ind AS 116",
        note: "Reviewer to confirm the current scope and requirements of Ind AS 116 for the FY.",
      },
    ]);
  });

  it("states non-applicability when the input says so", () => {
    const res = buildIndAsJudgmentRegister({ ...base, indAsApplicable: false });
    expect(res.applicability.note).toContain("not applicable");
  });
});

describe("buildIndAsJudgmentRegister: judgment merge", () => {
  it("merges custom areas onto the standing key-judgment list", () => {
    const res = buildIndAsJudgmentRegister(base);

    // 10 standing key areas + 1 custom area.
    expect(res.judgments).toHaveLength(11);
    const custom = res.judgments.find((j) => j.area === "Custom area")!;
    expect(custom.description).toBe("Group-specific policy");
    expect(custom.estimationUncertainty).toBe(true); // new areas are force-flagged
    expect(custom.critique).toBeTruthy();
  });

  it("ORs the uncertainty flag and keeps the standing description for an overlapping area", () => {
    const res = buildIndAsJudgmentRegister({
      ...base,
      // "Related party disclosures" is a standing area with uncertainty false.
      judgments: [{ area: "Related party disclosures", description: "ignored", estimationUncertainty: true }],
    });

    const standing = res.judgments.find((j) => j.area === "Related party disclosures")!;
    expect(standing.estimationUncertainty).toBe(true); // false OR true
    expect(standing.description).not.toBe("ignored"); // standing description retained
    expect(res.judgments).toHaveLength(10); // no duplicate
  });
});

describe("buildIndAsJudgmentRegister: transition and disclosures", () => {
  it("scaffolds the transition entry and disclosure checklist", () => {
    const res = buildIndAsJudgmentRegister(base);

    expect(res.transition).toEqual([
      {
        date: "2025-04-01",
        method: "full retrospective",
        openingAdjustment: 12_345,
        note: "Transition entry dated 2025-04-01 under full retrospective; opening adjustment 12345.",
      },
    ]);
    expect(res.disclosureChecklist).toHaveLength(8);
    expect(res.warnings).toHaveLength(2);
    expect(res.methodology.length).toBe(3);
  });
});
