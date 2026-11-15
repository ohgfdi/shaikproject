/**
 * SMS delivery — server-side only.
 *
 * Two transports, mirroring `lib/auth/mail.ts`:
 *
 * - `console` (default, dev/test): the message is printed to the server log and
 *   reported as `delivered: false` with `transport: "console"`. Nothing is
 *   claimed to have reached a handset.
 * - `twilio` (production): the Twilio REST API accepts the message and returns a
 *   provider SID. `delivered: true` means Twilio accepted it for delivery, not
 *   that the carrier confirmed it — the SID is the receipt.
 *
 * This module used to POST to `/api/send-sms`, a route that was never built, so
 * every "reminder" silently failed while callers counted it as sent. Delivery
 * is now in-process: no self-fetch, no missing route, and a truthful result.
 * Credentials come from validated env only (see `serverEnv`), never the DB.
 */

import { serverEnv } from "@/lib/env";

export type SmsTransport = "console" | "twilio";

export interface SendSmsParams {
  to: string;
  body: string;
  referenceId?: string;
  priority?: "normal" | "high";
}

export interface SendSmsResult {
  /** The transport accepted the message. Console transport also returns true. */
  success: boolean;
  /** The message actually left the building (false for the console transport). */
  delivered: boolean;
  transport: SmsTransport;
  sid?: string;
  status?: string;
  error?: string;
  referenceId?: string;
}

const E164 = /^\+[1-9]\d{0,14}$/;

export function smsTransport(): SmsTransport {
  return serverEnv().SMS_TRANSPORT;
}

export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const { to, body, referenceId } = params;
  const transport = smsTransport();

  if (!to || !body) {
    return { success: false, delivered: false, transport, error: "Missing: to or body", referenceId };
  }
  if (!E164.test(to)) {
    return {
      success: false,
      delivered: false,
      transport,
      error: "Invalid phone number format. Use E.164 (e.g. +919876543210)",
      referenceId,
    };
  }

  if (transport === "console") {
    // eslint-disable-next-line no-console
    console.log(
      [
        "---- Ledgerly outbound SMS (console transport — NOT delivered) ----",
        `To:      ${to}`,
        `Ref:     ${referenceId ?? "—"}`,
        "",
        body,
        "-------------------------------------------------------------------",
      ].join("\n"),
    );
    return { success: true, delivered: false, transport, status: "console", referenceId };
  }

  const env = serverEnv();
  try {
    const twilioModule = (await import("twilio")) as unknown as {
      default: (sid: string, token: string) => {
        messages: { create: (input: Record<string, unknown>) => Promise<{ sid: string; status: string }> };
      };
    };
    const client = twilioModule.default(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    const message = await client.messages.create({
      to,
      from: env.TWILIO_FROM,
      body,
    });
    return {
      success: true,
      delivered: true,
      transport,
      sid: message.sid,
      status: message.status,
      referenceId,
    };
  } catch (err) {
    return {
      success: false,
      delivered: false,
      transport,
      error: err instanceof Error ? err.message : "Twilio rejected the message.",
      referenceId,
    };
  }
}

export function notifyComplianceDeadline(
  to: string,
  engagementName: string,
  taskTitle: string,
  dueDate: string,
  daysLeft: number,
  referenceId?: string,
) {
  const urgency = daysLeft <= 3 ? "CRITICAL" : daysLeft <= 7 ? "WARNING" : "REMINDER";

  const body =
    "\n⚠️ " +
    urgency +
    " — Compliance Deadline\n\nEngagement: " +
    engagementName +
    "\nTask: " +
    taskTitle +
    "\nDue: " +
    dueDate +
    "\nDays left: " +
    daysLeft +
    "\n\nAction required: Log in to review and file before deadline.\n\n— Ledgerly Compliance Bot";

  return sendSms({ to, body, referenceId, priority: daysLeft <= 3 ? "high" : "normal" });
}

export function notifyEngagementAccess(
  to: string,
  engagementName: string,
  role: string,
  referenceId?: string,
) {
  const body =
    "\n✅ Engagement Access Granted\n\nEngagement: " +
    engagementName +
    "\nRole: " +
    role +
    "\n\nYou can now view documents, working papers, and deliverables. Login to the app.\n\n— Ledgerly Firm Portal";

  return sendSms({ to, body, referenceId, priority: "normal" });
}

export function notifyPaperReviewAssignment(
  to: string,
  paperTitle: string,
  engagementName: string,
  referenceId?: string,
) {
  const body =
    "\n📝 Review Assignment\n\nPaper: " +
    paperTitle +
    "\nEngagement: " +
    engagementName +
    "\n\nPlease review, add comments, and sign off within 48 hours.\n\n— Ledgerly Working Papers";

  return sendSms({ to, body, referenceId, priority: "normal" });
}

export function notifyDeliverableReady(
  to: string,
  deliverableName: string,
  engagementName: string,
  referenceId?: string,
) {
  const body =
    "\n📄 Deliverable Ready\n\nDeliverable: " +
    deliverableName +
    "\nEngagement: " +
    engagementName +
    "\n\nAvailable for download in the client portal.\n\n— Ledgerly Document Hub";

  return sendSms({ to, body, referenceId, priority: "normal" });
}

export async function broadcastSms(
  phoneNumbers: string[],
  body: string,
  referenceId: string,
  priority: "normal" | "high" = "normal",
): Promise<Array<SendSmsResult>> {
  const results = await Promise.all(
    phoneNumbers.map((phone) => sendSms({ to: phone, body, referenceId, priority })),
  );
  return results;
}

export function daysUntilDue(dueDate: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(dueDate).toISOString().slice(0, 10);
  const diffMs = new Date(due).getTime() - new Date(today).getTime();
  return Math.ceil(diffMs / 86400000);
}
