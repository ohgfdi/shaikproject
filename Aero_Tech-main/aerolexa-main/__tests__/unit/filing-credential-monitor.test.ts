/**
 * Scheduled filing-credential monitor tests.
 *
 * The fire → cooldown → recover decision is a pure oracle. The runner is
 * exercised with an injected preflight/recipients/send, so the alerting path is
 * verified with no portal and no database. A source-gated test pins the
 * scheduler wiring contract (the job runs from the poll tick, isolated).
 */
import { readFileSync } from "node:fs";

import { generateIrpKeyPair } from "@/lib/engine/filing/crypto";
import type { FilingPreflightResult } from "@/lib/engine/filing/types";
import { __resetServerEnvForTests } from "@/lib/env";
import {
  INITIAL_FILING_CREDENTIAL_STATE,
  __resetFilingCredentialMonitorForTests,
  nextFilingCredentialAction,
  runFilingCredentialCheck,
  type FilingCredentialCheckDeps,
} from "@/lib/server/filing-credential-monitor";

import { withEnvAsync } from "../helpers/temp-env";

const SCHEDULER_SRC = readFileSync(`${process.cwd()}/lib/server/scheduler.ts`, "utf8");

function preflightResult(overrides: Partial<FilingPreflightResult> = {}): FilingPreflightResult {
  return {
    provider: "live",
    channel: "irp-irn",
    ok: true,
    detail: "ok",
    sandbox: false,
    httpStatus: null,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Run a body with a fully-configured LIVE filing env (valid creds + key). */
async function withLiveFiling<T>(fn: () => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const { publicKeyPem } = generateIrpKeyPair();
  return withEnvAsync(
    {
      FILING_GATEWAY: "live",
      FILING_CHANNEL: "irp-irn",
      FILING_GSTIN: "27AAPFU0939F1ZV",
      FILING_IRP_CLIENT_ID: "id",
      FILING_IRP_CLIENT_SECRET: "secret",
      FILING_IRP_PORTAL_USER: "u",
      FILING_IRP_PORTAL_PASSWORD: "p",
      FILING_IRP_PUBLIC_KEY: publicKeyPem,
      // Keep probes from being throttled in the small-time-step cases; the
      // throttle itself is covered by its own test below.
      FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES: "1",
      ...extra,
    },
    async () => {
      __resetServerEnvForTests();
      return fn();
    },
  );
}

describe("nextFilingCredentialAction (pure)", () => {
  it("alerts on the first failure, dedupes within cooldown, re-alerts after it, and reports recovery", () => {
    const cooldown = 60_000;
    let state = INITIAL_FILING_CREDENTIAL_STATE;

    // Healthy → silent.
    let r = nextFilingCredentialAction(state, true, 1_000_000, cooldown);
    expect(r.action).toBe("none");
    state = r.state;

    // First failure always alerts.
    r = nextFilingCredentialAction(state, false, 1_001_000, cooldown);
    expect(r.action).toBe("alert");
    state = r.state;

    // Still failing inside the cooldown → silent.
    r = nextFilingCredentialAction(state, false, 1_002_000, cooldown);
    expect(r.action).toBe("none");
    state = r.state;

    // Still failing after the cooldown → alert again.
    r = nextFilingCredentialAction(state, false, 1_200_000, cooldown);
    expect(r.action).toBe("alert");
    state = r.state;

    // Recovery after an alert → one "recovered", and the cooldown is reset.
    r = nextFilingCredentialAction(state, true, 1_201_000, cooldown);
    expect(r.action).toBe("recovered");
    expect(r.state.alertedAtMs).toBeNull();
    state = r.state;

    // A fresh failure after recovery alerts immediately (no stale cooldown).
    r = nextFilingCredentialAction(state, false, 1_202_000, cooldown);
    expect(r.action).toBe("alert");
  });

  it("does not report recovery when it never alerted", () => {
    let state = INITIAL_FILING_CREDENTIAL_STATE;
    // A pass from the initial state is silent.
    let r = nextFilingCredentialAction(state, true, 1_000, 60_000);
    expect(r.action).toBe("none");
    state = r.state;
    // Fail (alert) …
    r = nextFilingCredentialAction(state, false, 2_000, 60_000);
    expect(r.action).toBe("alert");
    expect(r.state.alertedAtMs).toBe(2_000);
  });
});

describe("runFilingCredentialCheck", () => {
  afterEach(() => {
    __resetFilingCredentialMonitorForTests();
    __resetServerEnvForTests();
  });

  it("skips without touching the network when the monitor is disabled", async () => {
    await withEnvAsync({ FILING_CREDENTIAL_MONITOR_ENABLED: "false" }, async () => {
      __resetServerEnvForTests();
      let called = false;
      const result = await runFilingCredentialCheck(new Date(), {
        preflight: async () => {
          called = true;
          return preflightResult();
        },
      });
      expect(result.outcome).toBe("skipped");
      expect(called).toBe(false);
    });
  });

  it("skips when the filing provider is not live", async () => {
    await withEnvAsync({ FILING_GATEWAY: "simulation" }, async () => {
      __resetServerEnvForTests();
      let called = false;
      const result = await runFilingCredentialCheck(new Date(), {
        preflight: async () => {
          called = true;
          return preflightResult();
        },
      });
      expect(result.outcome).toBe("skipped");
      expect(called).toBe(false);
    });
  });

  it("alerts recipients on failure, dedupes within the cooldown, then reports recovery", async () => {
    await withLiveFiling(async () => {
      __resetFilingCredentialMonitorForTests();
      const sent: { userId: string; title: string; message: string }[] = [];
      const deps: FilingCredentialCheckDeps = {
        recipients: async () => ["u1", "u2"],
        send: async (userId, input) => {
          sent.push({ userId, title: input.title, message: input.message ?? "" });
        },
      };
      const failing = async () => preflightResult({ ok: false, detail: "Filing credentials rejected (401)." });
      const healthy = async () => preflightResult({ ok: true, detail: "handshake ok" });

      const first = await runFilingCredentialCheck(new Date("2026-10-17T00:00:00Z"), { ...deps, preflight: failing });
      expect(first.outcome).toBe("alerted");
      expect(first.recipients).toBe(2);
      expect(sent).toHaveLength(2);
      expect(sent[0]?.title).toMatch(/failing/i);
      expect(sent[0]?.message).toContain("gateway-preflight");

      sent.length = 0;
      const second = await runFilingCredentialCheck(new Date("2026-10-17T00:05:00Z"), { ...deps, preflight: failing });
      expect(second.outcome).toBe("degraded");
      expect(sent).toHaveLength(0);

      const recovered = await runFilingCredentialCheck(new Date("2026-10-17T00:10:00Z"), {
        ...deps,
        preflight: healthy,
      });
      expect(recovered.outcome).toBe("recovered");
      expect(sent).toHaveLength(2);
      expect(sent[0]?.title).toMatch(/restored/i);
    });
  });

  it("re-alerts after the cooldown elapses", async () => {
    await withLiveFiling(async () => {
      __resetFilingCredentialMonitorForTests();
      let sends = 0;
      const deps: FilingCredentialCheckDeps = {
        recipients: async () => ["u1"],
        send: async () => {
          sends += 1;
        },
      };
      const failing = async () => preflightResult({ ok: false, detail: "down" });

      await runFilingCredentialCheck(new Date("2026-10-17T00:00:00Z"), { ...deps, preflight: failing });
      expect(sends).toBe(1);

      // Default cooldown is 360 minutes; 400 later must alert again.
      const again = await runFilingCredentialCheck(new Date("2026-10-17T06:40:00Z"), { ...deps, preflight: failing });
      expect(again.outcome).toBe("alerted");
      expect(sends).toBe(2);
    });
  });

  it("does not re-probe before the check interval elapses", async () => {
    await withLiveFiling(
      async () => {
        __resetFilingCredentialMonitorForTests();
        let probes = 0;
        const deps: FilingCredentialCheckDeps = {
          preflight: async () => {
            probes += 1;
            return preflightResult();
          },
          recipients: async () => [],
        };
        const first = await runFilingCredentialCheck(new Date("2026-10-17T00:00:00Z"), deps);
        expect(first.outcome).toBe("healthy");

        // 10 minutes later, with a 60-minute interval, the probe is throttled.
        const second = await runFilingCredentialCheck(new Date("2026-10-17T00:10:00Z"), deps);
        expect(second.outcome).toBe("skipped");
        expect(probes).toBe(1);

        // Past the interval, it probes again.
        const third = await runFilingCredentialCheck(new Date("2026-10-17T01:30:00Z"), deps);
        expect(third.outcome).toBe("healthy");
        expect(probes).toBe(2);
      },
      { FILING_CREDENTIAL_CHECK_INTERVAL_MINUTES: "60" },
    );
  });

  it("treats a throwing preflight as a failure, not a crash", async () => {
    await withLiveFiling(async () => {
      __resetFilingCredentialMonitorForTests();
      const result = await runFilingCredentialCheck(new Date(), {
        preflight: async () => {
          throw new Error("ECONNREFUSED");
        },
        recipients: async () => [],
      });
      expect(result.outcome).toBe("alerted");
      expect(result.detail).toMatch(/ECONNREFUSED/);
    });
  });
});

describe("scheduler wiring contract", () => {
  it("runs the monitor from the poll tick, isolated so it cannot break the tick", () => {
    expect(SCHEDULER_SRC).toContain("filing-credential-monitor");
    const idx = SCHEDULER_SRC.indexOf("runFilingCredentialCheck(new Date())");
    expect(idx).toBeGreaterThan(-1);
    // The call sits inside a try/catch (the isolation contract).
    expect(SCHEDULER_SRC.slice(idx, idx + 220)).toContain("catch");
  });
});
