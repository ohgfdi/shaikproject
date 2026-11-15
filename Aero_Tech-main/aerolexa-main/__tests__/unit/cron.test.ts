/**
 * Unit tests for the minimal cron parser (lib/engine/cron.ts).
 */
import { CronError, nextRunAt, parseCron } from "@/lib/engine/cron";

describe("parseCron", () => {
  it("parses * * * * * as unrestricted", () => {
    const s = parseCron("* * * * *");
    expect(s.minute.restricted).toBe(false);
    expect(s.dow.restricted).toBe(false);
  });

  it("parses lists, ranges and steps", () => {
    const s = parseCron("0 9 * * 1");
    expect(s.minute.values.has(0)).toBe(true);
    expect(s.hour.values.has(9)).toBe(true);
    expect(s.dow.values.has(1)).toBe(true);
    const stepped = parseCron("*/5 * * * *");
    expect(stepped.minute.values.size).toBe(12); // 0,5,…,55
    expect(stepped.minute.restricted).toBe(true);
    const range = parseCron("0 9-17 * * *");
    expect(range.hour.values.has(9)).toBe(true);
    expect(range.hour.values.has(17)).toBe(true);
    expect(range.hour.values.size).toBe(9);
  });

  it("normalizes 7 to 0 for day-of-week", () => {
    const s = parseCron("0 9 * * 7");
    expect(s.dow.values.has(0)).toBe(true);
    expect(s.dow.values.has(7)).toBe(false);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("0 9 * *")).toThrow(CronError); // 4 fields
    expect(() => parseCron("60 9 * * *")).toThrow(CronError); // minute out of range
    expect(() => parseCron("0 9 * * mon")).toThrow(CronError); // names unsupported
  });
});

describe("nextRunAt", () => {
  it("computes the next daily-0900 run after a given date", () => {
    const from = new Date("2026-01-01T08:30:00Z");
    const next = nextRunAt("0 9 * * *", from);
    expect(next!.toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  it("rolls to the next day when the time has passed", () => {
    const from = new Date("2026-01-01T10:00:00Z");
    const next = nextRunAt("0 9 * * *", from);
    expect(next!.toISOString()).toBe("2026-01-02T09:00:00.000Z");
  });

  it("handles day-of-week restrictions (Monday 9am)", () => {
    // 2026-01-03 is a Saturday → next Monday is 2026-01-05.
    const from = new Date("2026-01-03T00:00:00Z");
    const next = nextRunAt("0 9 * * 1", from);
    expect(next!.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("handles monthly day-of-month restrictions", () => {
    const from = new Date("2026-01-02T00:00:00Z");
    const next = nextRunAt("0 0 1 * *", from);
    expect(next!.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("matches when either dom or dow matches (standard cron)", () => {
    // 1st of month OR Sunday, 09:00 — 2026-01-15 is a Thursday, so the next
    // trigger is Sunday 2026-01-18 (well before the 1st of February).
    const from = new Date("2026-01-15T00:00:00Z");
    const next = nextRunAt("0 9 1 * 0", from);
    expect(next!.toISOString()).toBe("2026-01-18T09:00:00.000Z");
  });

  it("accepts a parsed schedule object", () => {
    const schedule = parseCron("0 12 * * *");
    const from = new Date("2026-06-01T11:59:00Z");
    expect(nextRunAt(schedule, from)!.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });
});
