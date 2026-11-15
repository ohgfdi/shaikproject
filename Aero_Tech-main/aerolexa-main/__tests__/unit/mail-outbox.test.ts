import { outboxBackoffMs, summarizeOutbox } from "@/lib/server/mail-outbox";

describe("mail outbox", () => {
  it("backs off 30s, 60s, 2m and caps at an hour", () => {
    expect(outboxBackoffMs(1)).toBe(30_000);
    expect(outboxBackoffMs(2)).toBe(60_000);
    expect(outboxBackoffMs(3)).toBe(120_000);
    expect(outboxBackoffMs(20)).toBe(3_600_000);
  });

  it("counts only known states, so a future state never inflates the posture", () => {
    expect(
      summarizeOutbox([
        { status: "pending" },
        { status: "pending" },
        { status: "sent" },
        { status: "failed" },
        { status: "sending" },
        { status: "weird" },
      ]),
    ).toEqual({ pending: 2, sending: 1, sent: 1, failed: 1 });
  });
});
