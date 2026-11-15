import { computeChangeLog } from "@/lib/engine/connectors/changelog";

const base = [
  [1, "Ada"],
  [2, "Lin"],
  [3, "Grace"],
];

describe("connector sync change log", () => {
  it("reports no differences when nothing changed", () => {
    const log = computeChangeLog(base, [...base]);
    expect(log.rowsAdded).toBe(0);
    expect(log.rowsRemoved).toBe(0);
    expect(log.note).toMatch(/No row-level differences/i);
  });

  it("counts added and removed rows", () => {
    const next = [
      [1, "Ada"],
      [3, "Grace"],
      [4, "Katherine"],
    ];
    const log = computeChangeLog(base, next);
    expect(log.previousRowCount).toBe(3);
    expect(log.newRowCount).toBe(3);
    expect(log.rowsAdded).toBe(1); // Katherine
    expect(log.rowsRemoved).toBe(1); // Lin
    expect(log.note).toContain("1 row(s) added and 1 row(s) removed");
  });

  it("explains that an in-place edit counts as removal + addition", () => {
    const edited = [
      [1, "Ada"],
      [2, "Linus"], // renamed
      [3, "Grace"],
    ];
    const log = computeChangeLog(base, edited);
    expect(log.rowsAdded).toBe(1);
    expect(log.rowsRemoved).toBe(1);
    expect(log.note).toMatch(/in-place edit counts as one removal plus one addition/i);
  });

  it("handles empty inputs", () => {
    const log = computeChangeLog([], []);
    expect(log.rowsAdded).toBe(0);
    expect(log.rowsRemoved).toBe(0);
    expect(log.previousRowCount).toBe(0);
  });
});
