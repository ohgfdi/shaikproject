/**
 * Due-date drift: the engine reports the disagreement and never picks a winner.
 */

import { detectDueDateDrift } from "@/lib/engine/statute-drift";

const tracked = [
  { taskId: "c1:GSTR-3B:2026-10", dueDate: "2026-10-20", title: "GSTR-3B Oct", clientName: "Sharma" },
  { taskId: "c1:GSTR-1:2026-10", dueDate: "2026-10-11", title: "GSTR-1 Oct", clientName: "Sharma" },
  { taskId: "c1:TDS-26Q:Q2", dueDate: "2026-10-31", title: "TDS Q2", clientName: "Sharma" },
  { taskId: "c1:ITR:2026", dueDate: "2026-10-31", title: "ITR", clientName: "Sharma" },
];

describe("detectDueDateDrift", () => {
  it("reports an earlier deadline as a warning and a later one as info", () => {
    const drifts = detectDueDateDrift(tracked, [
      { taskId: "c1:GSTR-3B:2026-10", dueDate: "2026-10-18" },
      { taskId: "c1:GSTR-1:2026-10", dueDate: "2026-10-14" },
      { taskId: "c1:TDS-26Q:Q2", dueDate: "2026-10-31" },
      { taskId: "c1:ITR:2026", dueDate: "2026-11-10" },
    ]);

    expect(drifts).toHaveLength(3);
    expect(drifts[0]).toMatchObject({
      taskId: "c1:GSTR-3B:2026-10",
      storedDueDate: "2026-10-20",
      generatedDueDate: "2026-10-18",
      daysShifted: -2,
      direction: "advanced",
      severity: "warning",
    });
    expect(drifts[1]).toMatchObject({
      taskId: "c1:GSTR-1:2026-10",
      daysShifted: 3,
      direction: "postponed",
      severity: "info",
    });
    expect(drifts[2]).toMatchObject({ taskId: "c1:ITR:2026", daysShifted: 10, severity: "info" });
  });

  it("sorts warnings before info and then by stored date", () => {
    const drifts = detectDueDateDrift(tracked, [
      { taskId: "c1:ITR:2026", dueDate: "2026-11-10" },
      { taskId: "c1:GSTR-3B:2026-10", dueDate: "2026-10-18" },
      { taskId: "c1:GSTR-1:2026-10", dueDate: "2026-10-01" },
    ]);
    expect(drifts.map((d) => d.severity)).toEqual(["warning", "warning", "info"]);
    // Two warnings, sorted by stored date (Oct 11 before Oct 20).
    expect(drifts.map((d) => d.taskId)).toEqual([
      "c1:GSTR-1:2026-10",
      "c1:GSTR-3B:2026-10",
      "c1:ITR:2026",
    ]);
  });

  it("omits identical dates, tasks missing from the new calendar, and unparseable dates", () => {
    const drifts = detectDueDateDrift(
      [
        ...tracked,
        { taskId: "c1:PT-RETURN:2026", dueDate: "not-a-date", title: "PT", clientName: "Sharma" },
      ],
      [
        { taskId: "c1:GSTR-3B:2026-10", dueDate: "2026-10-18" },
        { taskId: "c1:GSTR-1:2026-10", dueDate: "2026-10-11" },
        { taskId: "c1:TDS-26Q:Q2", dueDate: "2026-10-31" },
        { taskId: "c1:ITR:2026", dueDate: "2026-10-31" },
        { taskId: "c1:PT-RETURN:2026", dueDate: "2026-11-30" },
        { taskId: "c1:NEW:2026", dueDate: "2026-12-01" },
      ],
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.taskId).toBe("c1:GSTR-3B:2026-10");
  });

  it("returns nothing when the firm is working from current dates", () => {
    expect(
      detectDueDateDrift(
        tracked,
        tracked.map((task) => ({ taskId: task.taskId, dueDate: task.dueDate })),
      ),
    ).toEqual([]);
  });
});
