/**
 * Production safety gate (launch readiness).
 *
 * `next start`, the shipped Docker images and the hosted runbook all run with
 * NODE_ENV=production. These tests pin the boot-time contract that a
 * production instance may not silently ship a dev transport: console mail
 * prints verification/reset links to the server log and disabling email
 * verification lets anyone register an address they do not control.
 *
 * The gate is validated through the real schema (superRefine included) via
 * __serverSchemaForTests, exactly like mail-transport.test.ts.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "prod-safety-test-secret-0123456789abcdef";

import { __serverSchemaForTests } from "@/lib/env";

import { withEnv } from "../helpers/temp-env";

const BASE = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ledgerly_test?sslmode=disable",
  AUTH_SECRET: "prod-safety-test-secret-0123456789abcdef",
};

describe("production safety gate — env contract", () => {
  it("refuses console mail + no email verification in production", () => {
    withEnv(
      {
        ...BASE,
        NODE_ENV: "production",
        MAIL_TRANSPORT: "console",
        AUTH_REQUIRE_EMAIL_VERIFY: undefined,
        ALLOW_INSECURE_PROD_TRANSPORTS: undefined,
      },
      () => {
        const result = __serverSchemaForTests.safeParse(process.env);
        expect(result.success).toBe(false);
        if (!result.success) {
          const paths = result.error.issues.map((i) => i.path.join("."));
          expect(paths).toContain("MAIL_TRANSPORT");
          expect(paths).toContain("AUTH_REQUIRE_EMAIL_VERIFY");
        }
      },
    );
  });

  it("accepts smtp mail + email verification in production", () => {
    withEnv(
      {
        ...BASE,
        NODE_ENV: "production",
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: "smtp.example.com",
        AUTH_REQUIRE_EMAIL_VERIFY: "true",
        ALLOW_INSECURE_PROD_TRANSPORTS: undefined,
      },
      () => {
        const result = __serverSchemaForTests.safeParse(process.env);
        expect(result.success).toBe(true);
      },
    );
  });

  it("allows an explicit, deliberate opt-out", () => {
    withEnv(
      {
        ...BASE,
        NODE_ENV: "production",
        MAIL_TRANSPORT: "console",
        AUTH_REQUIRE_EMAIL_VERIFY: undefined,
        ALLOW_INSECURE_PROD_TRANSPORTS: "true",
      },
      () => {
        const result = __serverSchemaForTests.safeParse(process.env);
        expect(result.success).toBe(true);
      },
    );
  });

  it("keeps the dev/test default untouched", () => {
    withEnv(
      {
        ...BASE,
        NODE_ENV: "test",
        MAIL_TRANSPORT: undefined,
        AUTH_REQUIRE_EMAIL_VERIFY: undefined,
        ALLOW_INSECURE_PROD_TRANSPORTS: undefined,
      },
      () => {
        const result = __serverSchemaForTests.safeParse(process.env);
        expect(result.success).toBe(true);
      },
    );
  });
});
