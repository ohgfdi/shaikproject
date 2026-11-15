import { DUE_SOON_DAYS, compareByDeadline, deadlineStatus } from "@/lib/engine/deadlines";

describe("deadlines", () => {
  const today = "2026-03-15";

  it("flags a passed deadline as overdue by the elapsed days", () => {
    expect(deadlineStatus("2026-03-10", today)).toEqual({ dueDate: "2026-03-10", daysLeft: -5, status: "overdue" });
  });

  it("keeps the due date itself and the soon window as due", () => {
    expect(deadlineStatus(today, today)).toEqual({ dueDate: today, daysLeft: 0, status: "due" });
    expect(deadlineStatus("2026-03-22", today)).toEqual({
      dueDate: "2026-03-22",
      daysLeft: DUE_SOON_DAYS,
      status: "due",
    });
  });

  it("treats anything beyond the window as upcoming", () => {
    expect(deadlineStatus("2026-03-23", today).status).toBe("upcoming");
  });

  it("survives an unparseable due date without throwing", () => {
    expect(deadlineStatus("not-a-date", today).daysLeft).toBe(0);
  });

  it("orders a register by deadline, then by label", () => {
    const rows = [
      { dueDate: "2026-04-01", label: "B" },
      { dueDate: "2026-03-20", label: "Z" },
      { dueDate: "2026-03-20", label: "A" },
    ];
    expect([...rows].sort(compareByDeadline).map((r) => r.label)).toEqual(["A", "Z", "B"]);
  });
});
