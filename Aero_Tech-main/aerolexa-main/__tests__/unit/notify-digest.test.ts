/**
 * Notification digest tests (ROADMAP 7.3).
 *
 * Pure-logic tests run the real render/format/mark functions against an
 * in-memory store; source-gated tests pin the wiring contract (env flag,
 * instrumentation hook, read-marking semantics) the same way
 * __tests__/unit/durable-queue.test.ts pins the job queue.
 */
import { readFileSync } from "node:fs";

import {
  DIGEST_MAX_ENTRIES,
  formatDigestLine,
  markDigestRead,
  renderDigestEmail,
  type DigestEntry,
} from "@/lib/server/notify-digest";

const SRC = readFileSync(`${process.cwd()}/lib/server/notify-digest.ts`, "utf8");

function entry(partial: Partial<DigestEntry>): DigestEntry {
  return {
    id: "n1",
    type: "report",
    title: "Scheduled report ready",
    message: "Q3 margin review was generated.",
    createdAt: new Date("2026-09-25T12:04:00Z"),
    ...partial,
  };
}

describe("digest — entry formatting", () => {
  it("formats an entry with type, title, message and UTC time", () => {
    const line = formatDigestLine(entry({}));
    expect(line).toBe("• [report] Scheduled report ready — Q3 margin review was generated. (12:04 UTC)");
  });

  it("omits the message segment when there is none", () => {
    const line = formatDigestLine(entry({ message: null }));
    expect(line).toBe("• [report] Scheduled report ready (12:04 UTC)");
  });
});

describe("digest — email rendering", () => {
  it("renders one entry with singular subject", () => {
    const { subject, text } = renderDigestEmail("Aditi", [entry({})], 1);
    expect(subject).toBe("Ledgerly — 1 unread notification");
    expect(text).toContain("Hi Aditi,");
    expect(text).toContain("• [report] Scheduled report ready");
    expect(text).toContain("/notifications");
  });

  it("pluralizes and lists multiple entries", () => {
    const entries = [
      entry({ id: "a" }),
      entry({ id: "b", type: "system", title: "Connector error", message: "Postgres connector unreachable." }),
    ];
    const { subject, text } = renderDigestEmail("Ravi", entries, 2);
    expect(subject).toBe("Ledgerly — 2 unread notifications");
    expect(text).toContain("[report]");
    expect(text).toContain("[system]");
  });

  it("summarizes overflow beyond the cap instead of silently dropping", () => {
    const many = Array.from({ length: DIGEST_MAX_ENTRIES }, (_, i) => entry({ id: `n${i}` }));
    const { text } = renderDigestEmail("Ravi", many, DIGEST_MAX_ENTRIES + 7);
    expect(text).toContain("… and 7 more");
  });

  it("empty inbox renders an explicit nothing-to-do email", () => {
    const { subject, text } = renderDigestEmail("Ravi", [], 0);
    expect(subject).toContain("no unread notifications");
    expect(text).toContain("no unread notifications");
  });
});

describe("digest — read-marking semantics (source-gated)", () => {
  it("marks only rows that are still unread (concurrent in-app read wins)", () => {
    expect(SRC).toContain("where: { id: { in: ids }, userId, readAt: null }");
  });

  it("marks nothing when the bundle is empty", async () => {
    // markDigestRead with an empty id list must be a no-op without touching Prisma.
    const count = await markDigestRead("u1", []);
    expect(count).toBe(0);
  });
});

describe("digest — wiring contract (source-gated)", () => {
  it("is env-gated on DIGEST_ENABLED and hooked from instrumentation", () => {
    expect(SRC).toContain('process.env.DIGEST_ENABLED !== "true"');
    const instrumentation = readFileSync(`${process.cwd()}/instrumentation.ts`, "utf8");
    expect(instrumentation).toContain("maybeStartDigestScheduler");
  });

  it("uses the same mail transport as the rest of the app", () => {
    expect(SRC).toContain('from "@/lib/auth/mail"');
  });

  it("the interval never holds the process open", () => {
    expect(SRC).toContain("unref");
  });

  it("DIGEST_ENABLED is declared in the env schema", () => {
    const env = readFileSync(`${process.cwd()}/lib/env.ts`, "utf8");
    expect(env).toContain("DIGEST_ENABLED");
  });
});
