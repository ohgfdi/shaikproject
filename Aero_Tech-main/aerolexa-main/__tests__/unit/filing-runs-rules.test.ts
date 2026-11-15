/**
 * Filing pipeline rules — the stage order, the role gate at each step and the
 * exact document a portal submission carries. These are the invariants that
 * make "separation of duties" a property of the code, not a promise in a doc.
 */

import {
  FILING_STAGES,
  filingStageRole,
  filingSubmissionPayload,
  nextFilingStage,
} from "@/lib/server/filing-runs";

describe("filing pipeline", () => {
  it("moves one stage at a time in the documented order", () => {
    expect(FILING_STAGES).toEqual([
      "computed",
      "prepared",
      "reviewed",
      "client-approved",
      "filed",
      "acknowledged",
    ]);
    expect(nextFilingStage("computed")).toBe("prepared");
    expect(nextFilingStage("prepared")).toBe("reviewed");
    expect(nextFilingStage("reviewed")).toBe("client-approved");
    expect(nextFilingStage("client-approved")).toBe("filed");
    expect(nextFilingStage("filed")).toBe("acknowledged");
    expect(nextFilingStage("acknowledged")).toBeNull();
  });

  it("requires the documented role at every gate", () => {
    expect(filingStageRole("computed")).toBeNull();
    expect(filingStageRole("prepared")).toBe("ASSISTANT");
    expect(filingStageRole("reviewed")).toBe("MANAGER");
    expect(filingStageRole("client-approved")).toBe("MANAGER");
    expect(filingStageRole("filed")).toBe("MANAGER");
    expect(filingStageRole("acknowledged")).toBe("ASSISTANT");
  });

  it("never requires a gate that no transition can reach", () => {
    for (const stage of FILING_STAGES) {
      if (stage === "computed") continue;
      expect(filingStageRole(stage)).not.toBeNull();
    }
  });

  it("builds a deterministic submission payload", () => {
    const run = {
      id: "run-1",
      engagementId: "eng-1",
      taskId: "gstr3b-2026-10",
      title: "GSTR-3B — October 2026",
      authority: "GSTN",
      dueDate: "2026-11-20",
    };
    const payload = filingSubmissionPayload(run);
    expect(payload).toEqual({
      formType: "GSTN",
      runId: "run-1",
      engagementId: "eng-1",
      taskId: "gstr3b-2026-10",
      title: "GSTR-3B — October 2026",
      dueDate: "2026-11-20",
      schemaVersion: "2026-11",
    });
    // Same input ⇒ identical bytes, so the gateway's digest is reproducible.
    expect(JSON.stringify(filingSubmissionPayload(run))).toBe(JSON.stringify(payload));
  });

  it("falls back to a generic form type when the authority is blank", () => {
    expect(
      filingSubmissionPayload({
        id: "r",
        engagementId: "e",
        taskId: "t",
        title: "Return",
        authority: "",
        dueDate: "2026-11-20",
      }).formType,
    ).toBe("STATUTORY_RETURN");
  });
});
