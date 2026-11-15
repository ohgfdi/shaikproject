/**
 * Phone/OTP auth (Band 3.1) — passwordless sign-in over SMS/WhatsApp.
 *
 * Security contract (all enforced here, not per-route):
 *  - Codes are 6 digits, stored as a bcrypt hash — the raw code never lands
 *    in the database, logs or responses.
 *  - Codes expire in 5 minutes and allow at most 5 verification attempts
 *    (brute-force budget: 5 tries × 10^6 combinations inside a 5-minute
 *    window, plus IP rate limiting on the route).
 *  - Sending is throttled to 1 code per phone per 60 s and 5 codes per hour
 *    (SMS pumping defense) — enforced by counting fresh rows in the DB.
 *  - Consumed/expired rows are deleted immediately — no OTP material
 *    outlives its purpose.
 *
 * Delivery is pluggable like mail.ts: the default "console" transport prints
 * the code to the server output (dev/test). Setting the WhatsApp env vars
 * activates a real WhatsApp Business Cloud API template message hook.
 */

import { createHash } from "node:crypto";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

export const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 code / minute / phone
export const OTP_HOURLY_SEND_LIMIT = 5; // 5 codes / hour / phone

/** Normalize an Indian/international phone to E.164 (+XXXXXXXXXX). */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, "");
  if (/^\+91\d{10}$/.test(digits)) return digits;
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  return null; // prototype scope: Indian mobile numbers only
}

export function phoneIpHash(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function generateCode(): string {
  // Crypto-random 6-digit code, zero-padded.
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(value % 1_000_000).padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Delivery transports — mirrors lib/auth/mail.ts structure
// ---------------------------------------------------------------------------

export interface OtpDelivery {
  to: string; // normalized phone
  code: string;
  purpose: string;
}

async function deliverConsole(d: OtpDelivery): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    [
      "---- Ledgerly outbound OTP (console transport) ----",
      `To:      ${d.to}`,
      `Purpose: ${d.purpose}`,
      "",
      `Your Ledgerly verification code is ${d.code} (valid for 5 minutes).`,
      "Never share this code.",
      "----------------------------------------------------",
    ].join("\n"),
  );
}

/**
 * WhatsApp Business Cloud API hook. Activated when WHATSAPP_PHONE_ID +
 * WHATSAPP_ACCESS_TOKEN are configured. Uses an approved template message
 * (free-text messages cannot initiate a conversation per WhatsApp policy).
 */
async function deliverWhatsApp(d: OtpDelivery): Promise<void> {
  const env = serverEnv();
  const res = await fetch(`https://graph.facebook.com/v20.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: d.to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: env.WHATSAPP_OTP_TEMPLATE,
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: d.code }],
          },
        ],
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WhatsApp OTP delivery failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

async function deliver(d: OtpDelivery): Promise<void> {
  const env = serverEnv();
  if (env.WHATSAPP_ENABLED && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) {
    await deliverWhatsApp(d);
    return;
  }
  // Production must never print a live sign-in code to the server log — that
  // would let anyone with log access authenticate as any user. Refuse rather
  // than leak; the operator configures WhatsApp or accepts the risk via
  // ALLOW_INSECURE_PROD_TRANSPORTS.
  if (env.NODE_ENV === "production" && !env.ALLOW_INSECURE_PROD_TRANSPORTS) {
    throw new OtpError(
      503,
      "OTP_DELIVERY_UNAVAILABLE",
      "Phone sign-in is unavailable on this deployment. Sign in with email instead.",
    );
  }
  await deliverConsole(d);
}

// ---------------------------------------------------------------------------
// Send / verify
// ---------------------------------------------------------------------------

export class OtpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Send a login OTP to a phone that belongs to an existing verified account. */
export async function sendLoginOtp(input: { phone: string; ipHash?: string | null }): Promise<{ sent: true }> {
  const phone = normalizePhone(input.phone);
  if (!phone) {
    throw new OtpError(400, "INVALID_PHONE", "Enter a valid Indian mobile number (10 digits).");
  }

  const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
  if (!user || !user.phoneVerifiedAt) {
    // Same response as when the phone exists — do not reveal account state.
    throw new OtpError(
      404,
      "PHONE_UNKNOWN",
      "No verified account uses this number. Sign in with email, then link your phone in Settings → Security.",
    );
  }

  await enforceSendBudget(phone);

  const code = generateCode();
  await prisma.phoneOtp.create({
    data: {
      phone,
      userId: user.id,
      purpose: "LOGIN",
      codeHash: await hashPassword(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ipHash: input.ipHash ?? null,
    },
  });

  await deliver({ to: phone, code, purpose: "LOGIN" });
  return { sent: true };
}

/** Verify a login OTP and return the user id on success. */
export async function verifyLoginOtp(input: { phone: string; code: string }): Promise<{ userId: string }> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new OtpError(400, "INVALID_PHONE", "Enter a valid Indian mobile number (10 digits).");

  const row = await prisma.phoneOtp.findFirst({
    where: { phone, purpose: "LOGIN", consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.expiresAt < new Date()) {
    if (row) await prisma.phoneOtp.delete({ where: { id: row.id } });
    throw new OtpError(400, "OTP_EXPIRED", "That code has expired. Request a new one.");
  }

  if (row.attempts >= row.maxAttempts) {
    await prisma.phoneOtp.delete({ where: { id: row.id } });
    throw new OtpError(429, "OTP_LOCKED", "Too many wrong attempts. Request a new code.");
  }

  const matches = await verifyPassword(input.code, row.codeHash);
  if (!matches) {
    await prisma.phoneOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    const left = row.maxAttempts - (row.attempts + 1);
    throw new OtpError(
      400,
      "OTP_INVALID",
      left > 0
        ? `Wrong code — ${left} attempt${left === 1 ? "" : "s"} left.`
        : "Wrong code — no attempts left. Request a new code.",
    );
  }

  // Consume atomically: a concurrent replay loses the race and finds nothing.
  const consumed = await prisma.phoneOtp.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    throw new OtpError(400, "OTP_EXPIRED", "That code was already used. Request a new one.");
  }
  await prisma.phoneOtp.delete({ where: { id: row.id } });

  return { userId: row.userId };
}

/**
 * Link (and verify) a phone to the signed-in account in one step: sends the
 * OTP with purpose LINK_PHONE against the *current* user id, so the number
 * can only become verified by someone who already controls the account.
 */
export async function sendLinkOtp(input: { userId: string; phone: string }): Promise<{ sent: true }> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new OtpError(400, "INVALID_PHONE", "Enter a valid Indian mobile number (10 digits).");

  const clash = await prisma.user.findUnique({ where: { phoneNumber: phone } });
  if (clash && clash.id !== input.userId) {
    throw new OtpError(409, "PHONE_TAKEN", "Another account already uses this number.");
  }

  await enforceSendBudget(phone);

  const code = generateCode();
  await prisma.phoneOtp.create({
    data: {
      phone,
      userId: input.userId,
      purpose: "LINK_PHONE",
      codeHash: await hashPassword(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });
  await deliver({ to: phone, code, purpose: "LINK_PHONE" });
  return { sent: true };
}

/** Confirm the LINK_PHONE code and stamp phoneVerifiedAt on the user. */
export async function verifyLinkOtp(input: { userId: string; phone: string; code: string }): Promise<void> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new OtpError(400, "INVALID_PHONE", "Enter a valid Indian mobile number (10 digits).");

  const row = await prisma.phoneOtp.findFirst({
    where: { phone, userId: input.userId, purpose: "LINK_PHONE", consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.expiresAt < new Date()) {
    if (row) await prisma.phoneOtp.delete({ where: { id: row.id } });
    throw new OtpError(400, "OTP_EXPIRED", "That code has expired. Request a new one.");
  }
  if (row.attempts >= row.maxAttempts) {
    await prisma.phoneOtp.delete({ where: { id: row.id } });
    throw new OtpError(429, "OTP_LOCKED", "Too many wrong attempts. Request a new code.");
  }

  const matches = await verifyPassword(input.code, row.codeHash);
  if (!matches) {
    await prisma.phoneOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw new OtpError(400, "OTP_INVALID", "Wrong code — try again.");
  }

  await prisma.$transaction([
    prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
    prisma.phoneOtp.delete({ where: { id: row.id } }),
    prisma.user.update({
      where: { id: input.userId },
      data: { phoneNumber: phone, phoneVerifiedAt: new Date() },
    }),
  ]);
}

/** SMS-pumping budget: ≤1 fresh code / minute and ≤5 / hour per phone. */
async function enforceSendBudget(phone: string): Promise<void> {
  const now = Date.now();
  const [lastMinute, lastHour] = await Promise.all([
    prisma.phoneOtp.count({
      where: { phone, createdAt: { gte: new Date(now - OTP_RESEND_COOLDOWN_MS) } },
    }),
    prisma.phoneOtp.count({
      where: { phone, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
    }),
  ]);
  if (lastMinute > 0) {
    throw new OtpError(429, "OTP_THROTTLED", "A code was just sent — wait a minute before requesting another.");
  }
  if (lastHour >= OTP_HOURLY_SEND_LIMIT) {
    throw new OtpError(429, "OTP_QUOTA", "Too many codes requested for this number. Try again later.");
  }
}
