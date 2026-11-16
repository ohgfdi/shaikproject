/**
 * Client portal identity — the difference between "someone holding the link"
 * and "the person we invited".
 *
 * The portal link is a bearer token: whoever has it can act. That is fine for
 * read-only access, but an approval is a named act. This module adds a firm-
 * invited client account and a short-lived magic-link sign-in, so an approval
 * can be bound to a person and an email domain the firm chose.
 *
 * Security model:
 *  - accounts are created by the firm (PARTNER/MANAGER), never self-registered;
 *  - login tokens are 256-bit secrets, stored as SHA-256; they expire in 15
 *    minutes and are single-use;
 *  - a session is an HS256 JWT in an httpOnly cookie, scoped to one account and
 *    re-checked against the database on every read (revocation and archived
 *    engagements take effect immediately);
 *  - requesting a link is answered identically whether or not the email is
 *    invited, so the portal is not an account oracle.
 */

 * tenancy-audit: global-operator — portal-auth provides token-based access to engagement deliverables. This is a deployment-wide aggregate rather than a per-tenant query.


import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";

import { ApiError, type AuthContext } from "@/lib/auth/guard";
import { mailFooter, sendMail } from "@/lib/auth/mail";
import { prisma } from "@/lib/db";
import { appUrl, serverEnv } from "@/lib/env";
import { resolvePortalToken } from "@/lib/server/client-portal";
import { canManageAccess, requireEngagementRole } from "@/lib/server/engagement";

export const PORTAL_SESSION_COOKIE = "ledgerly.portal.session";
export const PORTAL_LOGIN_TTL_MS = 15 * 60 * 1000;
export const PORTAL_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Wire-contract values (not brand strings) so outstanding sessions survive a rename. */
const ISSUER = "aerolexa";
const AUDIENCE = "aerolexa-portal";

export function normalizePortalEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, 320);
}

/** Conservative on purpose: a malformed address cannot become an account. */
export function isValidPortalEmail(value: string): boolean {
  const email = normalizePortalEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function newPortalLoginToken(): { raw: string; hash: string } {
  const raw = `lpl_login_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

export function hashPortalLoginToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type PortalLoginTokenState = "active" | "used" | "expired";

export function portalLoginTokenState(
  token: { usedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): PortalLoginTokenState {
  if (token.usedAt) return "used";
  return token.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

export interface PortalInviteDelivery {
  status: "pending" | "sent" | "failed";
  error: string | null;
  sentAt: string | null;
}

export interface PortalAccountView {
  id: string;
  email: string;
  name: string | null;
  revokedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  /** Outcome of the most recent magic-link send (firm-visible only). */
  lastInvite: PortalInviteDelivery | null;
}

export interface PortalAccountSession {
  accountId: string;
  organizationId: string;
  engagementId: string;
  email: string;
  name: string | null;
}

function toAccountView(
  row: {
    id: string;
    email: string;
    name: string | null;
    revokedAt: Date | null;
    lastLoginAt: Date | null;
    createdAt: Date;
  },
  lastInvite: PortalInviteDelivery | null = null,
): PortalAccountView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastInvite,
  };
}

type LatestDeliveryRow = {
  deliveryStatus: string;
  deliveryError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
};

function lastInviteOf(tokens: LatestDeliveryRow[]): PortalInviteDelivery | null {
  const token = tokens[0];
  if (!token) return null;
  const status =
    token.deliveryStatus === "sent" || token.deliveryStatus === "failed" ? token.deliveryStatus : "pending";
  return {
    status,
    error: token.deliveryError,
    sentAt: token.deliveredAt ? token.deliveredAt.toISOString() : null,
  };
}

/** Record whether a magic link left the server (never throws). */
async function recordDelivery(
  tokenId: string,
  status: "sent" | "failed",
  error: string | null = null,
): Promise<void> {
  await prisma.clientPortalLoginToken
    .update({
      where: { id: tokenId },
      data: {
        deliveryStatus: status,
        deliveryError: error ? error.slice(0, 500) : null,
        deliveredAt: status === "sent" ? new Date() : null,
      },
    })
    .catch(() => undefined);
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(serverEnv().AUTH_SECRET);
}

export function portalSessionCookie(token: string): {
  name: string;
  value: string;
  options: Record<string, unknown>;
} {
  return {
    name: PORTAL_SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.AUTH_COOKIE_SECURE
        ? process.env.AUTH_COOKIE_SECURE === "true"
        : process.env.NODE_ENV === "production",
      path: "/",
      maxAge: PORTAL_SESSION_TTL_SECONDS,
    },
  };
}

export function clearPortalSessionCookie(): {
  name: string;
  value: string;
  options: Record<string, unknown>;
} {
  return {
    name: PORTAL_SESSION_COOKIE,
    value: "",
    options: { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 },
  };
}

async function mintPortalSession(account: {
  id: string;
  organizationId: string;
  engagementId: string;
  email: string;
  name: string | null;
}): Promise<string> {
  return new SignJWT({
    org: account.organizationId,
    eng: account.engagementId,
    email: account.email,
    name: account.name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(account.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${PORTAL_SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

/**
 * Read the portal session from the request cookie. Returns null for an absent,
 * expired or revoked session. The database is authoritative: a revoked account
 * or an archived engagement invalidates the token immediately.
 */
export async function readPortalSession(): Promise<PortalAccountSession | null> {
  const store = await cookies();
  const token = store.get(PORTAL_SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience: AUDIENCE });
    if (!payload.sub) return null;
    const account = await prisma.clientPortalAccount.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        organizationId: true,
        engagementId: true,
        email: true,
        name: true,
        revokedAt: true,
        engagement: { select: { status: true } },
      },
    });
    if (!account || account.revokedAt || account.engagement.status === "ARCHIVED") return null;
    return {
      accountId: account.id,
      organizationId: account.organizationId,
      engagementId: account.engagementId,
      email: account.email,
      name: account.name,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firm-side account management
// ---------------------------------------------------------------------------

async function requireAccountManager(ctx: AuthContext, engagementId: string): Promise<void> {
  const { role } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  if (!canManageAccess(role)) {
    throw new ApiError(403, "FORBIDDEN", "Only a partner or manager can manage client portal accounts.");
  }
}

export async function listPortalAccounts(
  ctx: AuthContext,
  engagementId: string,
): Promise<PortalAccountView[]> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "ASSISTANT");
  const rows = await prisma.clientPortalAccount.findMany({
    where: { engagementId: engagement.id },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    take: 100,
    include: {
      loginTokens: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { deliveryStatus: true, deliveryError: true, createdAt: true, deliveredAt: true },
      },
    },
  });
  return rows.map((row) => toAccountView(row, lastInviteOf(row.loginTokens)));
}

/**
 * Invite (or re-invite) a client person and email them a sign-in link.
 *
 * The account is scoped to the engagement, so the same address at two firms is
 * two independent accounts. Re-inviting a revoked account reactivates it rather
 * than creating a duplicate.
 */
export async function invitePortalAccount(
  ctx: AuthContext,
  engagementId: string,
  input: { email: string; name?: string | null },
): Promise<{ account: PortalAccountView; sent: boolean; expiresAt: string }> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  await requireAccountManager(ctx, engagementId);

  const email = normalizePortalEmail(input.email);
  if (!isValidPortalEmail(email)) {
    throw new ApiError(400, "VALIDATION", "Enter a valid client email address.");
  }
  const name = input.name?.trim().slice(0, 120) || null;

  const account = await prisma.clientPortalAccount.upsert({
    where: { engagementId_email: { engagementId: engagement.id, email } },
    create: {
      organizationId: engagement.organizationId,
      engagementId: engagement.id,
      email,
      name,
      createdById: ctx.user.id,
    },
    update: { name, revokedAt: null },
  });

  const { raw, hash } = newPortalLoginToken();
  const expiresAt = new Date(Date.now() + PORTAL_LOGIN_TTL_MS);
  const loginToken = await prisma.clientPortalLoginToken.create({
    data: { accountId: account.id, tokenHash: hash, expiresAt },
  });

  // The invite link is addressed to the engagement, not to a portal token: the
  // client may not have their read-only link handy. The session it creates is
  // scoped to the same engagement.
  const link = `${appUrl()}/portal/login/verify?t=${encodeURIComponent(raw)}`;
  try {
    await sendMail({
      to: email,
      subject: "Sign in to your client portal",
      text: [
        `Hello${name ? ` ${name}` : ""},`,
        "",
        `${ctx.organization?.name ?? "Your CA firm"} invited you to sign in to your client portal.`,
        "This link expires in 15 minutes and can be used once:",
        link,
        "",
        "Signing in lets the firm record your approvals against your name and email.",
        mailFooter(),
      ].join("\n"),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown mail error";
    await recordDelivery(loginToken.id, "failed", detail);
    throw new ApiError(
      502,
      "PORTAL_INVITE_MAIL",
      `The client account was created, but the sign-in email could not be sent: ${detail}. Fix the mail transport (MAIL_TRANSPORT/SMTP_*), then send the invitation again.`,
    );
  }
  await recordDelivery(loginToken.id, "sent");

  return {
    account: toAccountView(account, { status: "sent", error: null, sentAt: new Date().toISOString() }),
    sent: true,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function revokePortalAccount(
  ctx: AuthContext,
  engagementId: string,
  accountId: string,
): Promise<PortalAccountView> {
  const { engagement } = await requireEngagementRole(ctx, engagementId, "MANAGER");
  await requireAccountManager(ctx, engagementId);
  const account = await prisma.clientPortalAccount.findFirst({
    where: { id: accountId, engagementId: engagement.id },
  });
  if (!account) throw new ApiError(404, "NOT_FOUND", "Portal account not found.");
  const updated = account.revokedAt
    ? account
    : await prisma.clientPortalAccount.update({
        where: { id: account.id },
        data: { revokedAt: new Date() },
      });
  return toAccountView(updated);
}

// ---------------------------------------------------------------------------
// Client-side sign-in
// ---------------------------------------------------------------------------

/**
 * Send a sign-in link when the email is invited for this engagement.
 *
 * The response is deliberately identical either way: a client learns whether
 * they are invited from their inbox, not from the portal.
 */
export async function requestPortalLogin(
  rawPortalToken: string,
  emailInput: string,
  ipHash: string | null = null,
): Promise<{ sent: true }> {
  const { engagement } = await resolvePortalToken(rawPortalToken);
  const email = normalizePortalEmail(emailInput);
  if (!isValidPortalEmail(email)) return { sent: true };

  const account = await prisma.clientPortalAccount.findUnique({
    where: { engagementId_email: { engagementId: engagement.id, email } },
  });
  if (!account || account.revokedAt) return { sent: true };

  const { raw, hash } = newPortalLoginToken();
  const loginToken = await prisma.clientPortalLoginToken.create({
    data: {
      accountId: account.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + PORTAL_LOGIN_TTL_MS),
      ipHash,
    },
  });

  const link = `${appUrl()}/portal/${encodeURIComponent(rawPortalToken)}/login/verify?t=${encodeURIComponent(raw)}`;
  try {
    await sendMail({
      to: email,
      subject: "Your client portal sign-in link",
      text: [
        `Hello${account.name ? ` ${account.name}` : ""},`,
        "",
        "Use this link to sign in to your client portal. It expires in 15 minutes and can be used once:",
        link,
        "",      "If you did not ask for this link, you can ignore this email.",
      mailFooter(),
    ].join("\n"),
    });
  } catch (err) {
    // Do not reveal whether the address exists (or that mail is misconfigured)
    // through this public endpoint. The failure is recorded for the firm.
    // eslint-disable-next-line no-console
    console.warn("[portal-auth] sign-in link delivery failed", err instanceof Error ? err.message : err);
    await recordDelivery(loginToken.id, "failed", err instanceof Error ? err.message : "unknown mail error");
    return { sent: true };
  }
  await recordDelivery(loginToken.id, "sent");
  return { sent: true };
}

export interface VerifiedPortalLogin {
  account: PortalAccountView;
  engagement: { id: string; name: string };
  sessionToken: string;
}

/** Consume a one-time login token and mint a portal session. */
export async function verifyPortalLogin(raw: string): Promise<VerifiedPortalLogin> {
  if (!raw || raw.length < 20 || raw.length > 200) {
    throw new ApiError(404, "PORTAL_LOGIN_INVALID", "This sign-in link is invalid or has expired.");
  }
  const row = await prisma.clientPortalLoginToken.findUnique({
    where: { tokenHash: hashPortalLoginToken(raw) },
    include: {
      account: {
        include: { engagement: { select: { id: true, name: true, status: true } } },
      },
    },
  });
  if (!row || portalLoginTokenState(row) !== "active") {
    throw new ApiError(404, "PORTAL_LOGIN_INVALID", "This sign-in link is invalid or has expired.");
  }
  if (row.account.revokedAt || row.account.engagement.status === "ARCHIVED") {
    throw new ApiError(403, "PORTAL_ACCOUNT_REVOKED", "This portal account is no longer active.");
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.clientPortalLoginToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    prisma.clientPortalAccount.update({ where: { id: row.accountId }, data: { lastLoginAt: now } }),
  ]);

  return {
    account: toAccountView(row.account),
    engagement: { id: row.account.engagement.id, name: row.account.engagement.name },
    sessionToken: await mintPortalSession(row.account),
  };
}
