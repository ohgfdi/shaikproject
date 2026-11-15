/**
 * Mail transport tests — the contract without a live SMTP server.
 *
 * CI runs with MAIL_TRANSPORT=console (a live SMTP dependency would make the
 * suite flaky and leak credentials), so these tests pin:
 * 1. the env schema contract (smtp requires host — boot fails otherwise),
 * 2. the wiring contract (nodemailer is a real dependency, dynamic import,
 *    from-address, fail-loud delivery errors),
 * 3. real console-transport behavior for the dev path.
 *
 * Env bootstrap (repo convention — see tenancy-isolation.test.ts): CI exports
 * DATABASE_URL/AUTH_SECRET, but a fresh clone has no `.env`, and serverEnv()
 * validates both on first use. These scratch defaults are therefore set before
 * the module graph below is evaluated — a real value in the environment always
 * wins. Without them every test in this file reported an env error instead of
 * its own contract.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "mail-transport-test-secret-0123456789abcdef";

import { readFileSync } from "node:fs";

import { sendMail } from "@/lib/auth/mail";
import { __serverSchemaForTests } from "@/lib/env";

import { withEnv, withEnvAsync } from "../helpers/temp-env";

const MAIL_SRC = readFileSync(`${process.cwd()}/lib/auth/mail.ts`, "utf8");

describe("mail transport — env contract (real schema validation)", () => {
  it("MAIL_TRANSPORT=smtp without SMTP_HOST fails env validation at boot", () => {
    withEnv({ MAIL_TRANSPORT: "smtp", SMTP_HOST: undefined }, () => {
      const result = __serverSchemaForTests.safeParse(process.env);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("SMTP_HOST"))).toBe(true);
      }
    });
  });

  it("MAIL_TRANSPORT=smtp with a host parses and defaults STARTTLS (secure=false, port 587)", () => {
    withEnv(
      { MAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: undefined, SMTP_SECURE: undefined },
      () => {
        const result = __serverSchemaForTests.safeParse(process.env);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.SMTP_PORT).toBe(587);
          expect(result.data.SMTP_SECURE).toBe(false);
        }
      },
    );
  });

  it("console transport (the default) never requires SMTP fields", () => {
    withEnv({ MAIL_TRANSPORT: undefined, SMTP_HOST: undefined }, () => {
      const result = __serverSchemaForTests.safeParse(process.env);
      expect(result.success).toBe(true);
    });
  });
});

describe("mail transport — wiring contract (source-gated)", () => {
  it("nodemailer is a real production dependency", () => {
    const pkg = JSON.parse(readFileSync(`${process.cwd()}/package.json`, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.nodemailer).toBeDefined();
  });

  it("the transporter is created through a dynamic import with env-only credentials", () => {
    expect(MAIL_SRC).toContain('import("nodemailer")');
    expect(MAIL_SRC).toContain("host: env.SMTP_HOST");
    expect(MAIL_SRC).toContain("user: env.SMTP_USER");
  });

  it("delivery failures throw (never a silent console downgrade)", () => {
    expect(MAIL_SRC).toContain("SMTP delivery failed");
  });

  it("the from address comes from MAIL_FROM", () => {
    expect(MAIL_SRC).toContain("from: env.MAIL_FROM");
  });
});

describe("mail transport — console path (real behavior)", () => {
  it("console transport emits the structured block and resolves", async () => {
    await withEnvAsync({ MAIL_TRANSPORT: "console" }, async () => {
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await expect(sendMail({ to: "a@b.c", subject: "S", text: "hello" })).resolves.toBeUndefined();
        // Resolving is not enough: the transport must actually print the
        // message (a silent drop is the failure mode this guards).
        expect(logSpy.mock.calls[0]?.[0]).toContain("a@b.c");
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});
