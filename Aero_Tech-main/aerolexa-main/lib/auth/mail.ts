import { ApiError } from "@/lib/auth/guard";
import { appUrl, serverEnv } from "@/lib/env";

/**
 * Mail abstraction. Two transports:
 *
 * - `console` (default, dev/test): outgoing messages are printed to the
 *   server output so the full verify/reset flow is testable without an SMTP
 *   account.
 * - `smtp` (production): nodemailer over SMTP — host/port/user/password come
 *   from validated env only (never from the DB, never hard-coded). The
 *   transporter is created lazily and cached module-scope so connections
 *   pool across sends.
 *
 * No credentials are embedded anywhere; a missing-but-required credential is
 * a boot-time Zod error (see lib/env.ts), not a runtime surprise.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

type NodemailerModule = typeof import("nodemailer");

let transporter: import("nodemailer").Transporter | null = null;
let transporterTried = false;

/** Lazily create the SMTP transporter. Returns null when transport is console. */
async function getSmtpTransporter(): Promise<import("nodemailer").Transporter | null> {
  const env = serverEnv();
  if (env.MAIL_TRANSPORT !== "smtp") return null;
  if (transporter || transporterTried) return transporter;

  transporterTried = true;
  try {
    // Dynamic import so the console transport never loads the dependency
    // (serverless bundles, edge runtimes, test environments).
    const nodemailer = (await import("nodemailer")) as NodemailerModule;
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE, // true = implicit TLS (usually port 465)
      auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  } catch (err) {
    // Dependency unavailable is an operational error, not a config error —
    // surface it with the repo's readable-error contract.
    throw new ApiError(
      500,
      "MAIL_TRANSPORT",
      `SMTP transport selected but nodemailer failed to load: ${err instanceof Error ? err.message : "unknown error"}. What happened: the mail dependency is missing. How to fix: run npm install and restart.`,
    );
  }
  return transporter;
}

/** Test-only reset so each test gets a fresh transporter decision. */
export function __resetMailTransporterForTests(): void {
  transporter = null;
  transporterTried = false;
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const transport = serverEnv().MAIL_TRANSPORT;
  if (transport === "console") {
    // eslint-disable-next-line no-console
    console.log(
      [
        "---- Ledgerly outbound mail (console transport) ----",
        `To:      ${mail.to}`,
        `Subject: ${mail.subject}`,
        "",
        mail.text,
        "----------------------------------------------------",
      ].join("\n"),
    );
    return;
  }

  const smtp = await getSmtpTransporter();
  if (!smtp) {
    // Unreachable in practice (superRefine guarantees host when transport is
    // smtp) — kept as a fail-loud guard, never a silent console downgrade.
    throw new ApiError(
      500,
      "MAIL_TRANSPORT",
      "MAIL_TRANSPORT=smtp but the transporter could not be created. What happened: SMTP configuration is incomplete. How to fix: set SMTP_HOST (and SMTP_USER/SMTP_PASS) in the environment and restart.",
    );
  }

  const env = serverEnv();
  try {
    await smtp.sendMail({
      from: env.MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    });
  } catch (err) {
    // Delivery failure must be visible to callers (verification emails,
    // scheduled reports, the digest) — wrap with the readable-error contract
    // instead of leaking raw SMTP errors upward.
    const detail = err instanceof Error ? err.message : "unknown SMTP error";
    throw new ApiError(
      502,
      "MAIL_TRANSPORT",
      `SMTP delivery failed: ${detail}. What happened: the mail server rejected or could not reach the message. How to fix: verify SMTP_HOST/PORT/USER/PASSWORD and the provider's from-address rules, then retry.`,
    );
  }
}

export function mailFooter(): string {
  const from = serverEnv().MAIL_FROM;
  const url = appUrl();
  return `\n\n--\nSent by Ledgerly (${from}) · ${url}\nPrototype build — demo-mode logic may be used.`;
}
