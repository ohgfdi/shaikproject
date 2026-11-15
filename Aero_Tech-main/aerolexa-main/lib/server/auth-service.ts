import { ApiError } from "@/lib/auth/guard";
import { sendMail, mailFooter } from "@/lib/auth/mail";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/password";
import {
  createMfaChallengeToken,
  createSessionToken,
  createSessionCookie,
  revokeUserSessions,
} from "@/lib/auth/session";
import { generateToken, hashToken, TOKEN_TTL } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { appUrl, serverEnv } from "@/lib/env";
import { stringifyJson } from "@/lib/json";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/types";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SESSION_MAX_AGE = serverEnv().SESSION_TTL_DAYS * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerUser(input: { name: string; email: string; password: string }) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2) throw new ApiError(400, "VALIDATION", "Please enter your full name (at least 2 characters).");
  if (!EMAIL_RE.test(email)) throw new ApiError(400, "VALIDATION", "Please enter a valid email address.");
  const pw = validatePasswordStrength(input.password);
  if (!pw.ok) throw new ApiError(400, "VALIDATION", pw.message ?? "Password too weak.");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists. Sign in instead.");
  }

  const passwordHash = await hashPassword(input.password);
  const requireVerify = serverEnv().AUTH_REQUIRE_EMAIL_VERIFY;
  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      emailVerifiedAt: requireVerify ? null : new Date(),
      workspace: {
        create: {
          name: `${name.split(" ")[0]}'s workspace`,
          settings: stringifyJson({ ...DEFAULT_WORKSPACE_SETTINGS }),
        },
      },
    },
    include: { workspace: true },
  });

  const token = generateToken();
  await prisma.verificationToken.create({
    data: {
      tokenHash: token.hash,
      userId: user.id,
      kind: "VERIFY_EMAIL",
      expiresAt: new Date(Date.now() + TOKEN_TTL.VERIFY_EMAIL),
    },
  });

  // Phase 5.1: start the Pro trial so the user can experience what they would
  // be paying for. Best-effort by design — startTrial swallows its own
  // failures, because a trial is a marketing affordance and must never be
  // able to fail a signup. A user whose trial cannot start simply gets the
  // free tier, which is what they would have had anyway.
  if (user.workspace) {
    const { startTrial } = await import("./trial");
    await startTrial(user.workspace.id);
  }

  await sendMail({
    to: user.email,
    subject: "Verify your Ledgerly account",
    text: `Hi ${user.name},\n\nWelcome to Ledgerly. Verify your email to finish setting up your account:\n\n${appUrl()}/verify-email?token=${token.raw}\n\nIf you didn't create an account, you can safely ignore this email.${mailFooter()}`,
  });

  // In development verification is usually disabled — sign straight in.
  if (requireVerify) {
    return { user: safeUser(user), session: null as string | null };
  }
  const session = await createSessionToken(user.id);
  return { user: safeUser(user), session };
}

export async function verifyEmail(rawToken: string): Promise<{ user: { id: string } }> {
  const hash = hashToken(rawToken);
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });
  if (!record || record.kind !== "VERIFY_EMAIL") {
    throw new ApiError(400, "INVALID_TOKEN", "That verification link is invalid. Request a new one.");
  }
  if (record.usedAt)
    throw new ApiError(400, "INVALID_TOKEN", "That verification link was already used. Sign in instead.");
  if (record.expiresAt < new Date()) {
    throw new ApiError(400, "EXPIRED_TOKEN", "That verification link has expired. Request a new one.");
  }
  await prisma.$transaction([
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
  return { user: { id: record.userId } };
}

export async function resendVerification(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // do not reveal account existence
  const token = generateToken();
  await prisma.verificationToken.create({
    data: {
      tokenHash: token.hash,
      userId: user.id,
      kind: "VERIFY_EMAIL",
      expiresAt: new Date(Date.now() + TOKEN_TTL.VERIFY_EMAIL),
    },
  });
  await sendMail({
    to: email,
    subject: "Verify your Ledgerly account",
    text: `Hi ${user.name},\n\nHere is a fresh verification link:\n\n${appUrl()}/verify-email?token=${token.raw}${mailFooter()}`,
  });
}

// ---------------------------------------------------------------------------
// Login / sessions
// ---------------------------------------------------------------------------

export async function loginUser(input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
  }
  const matches = await verifyPassword(input.password, user.passwordHash);
  if (!matches) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
  }
  if (!user.emailVerifiedAt && serverEnv().AUTH_REQUIRE_EMAIL_VERIFY) {
    throw new ApiError(403, "EMAIL_UNVERIFIED", "Please verify your email address before signing in.");
  }
  // Password success is not a session when MFA is enrolled: hand back a
  // five-minute challenge and let /api/auth/mfa/verify mint the session.
  if (user.mfaEnabledAt) {
    if (!user.mfaSecret) {
      // Fail closed: an enrolled account without a seed is a data fault, not a
      // reason to issue a password-only session.
      throw new ApiError(500, "MFA_MISCONFIGURED", "Two-factor authentication is misconfigured. Contact an operator.");
    }
    return {
      user: safeUser(user),
      session: null,
      mfaRequired: true as const,
      challenge: await createMfaChallengeToken(user.id),
    };
  }
  const session = await createSessionToken(user.id);
  return { user: safeUser(user), session, mfaRequired: false as const, challenge: null };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export async function requestPasswordReset(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // never reveal whether an account exists
  const token = generateToken();
  await prisma.verificationToken.create({
    data: {
      tokenHash: token.hash,
      userId: user.id,
      kind: "RESET_PASSWORD",
      expiresAt: new Date(Date.now() + TOKEN_TTL.RESET_PASSWORD),
    },
  });
  await sendMail({
    to: email,
    subject: "Reset your Ledgerly password",
    text: `Hi ${user.name},\n\nWe received a request to reset your password:\n\n${appUrl()}/reset-password?token=${token.raw}\n\nThis link expires in 1 hour. If you didn't request it, ignore this email.${mailFooter()}`,
  });
}

export async function resetPassword(rawToken: string, password: string) {
  const pw = validatePasswordStrength(password);
  if (!pw.ok) throw new ApiError(400, "VALIDATION", pw.message ?? "Password too weak.");
  const hash = hashToken(rawToken);
  const record = await prisma.verificationToken.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });
  if (!record || record.kind !== "RESET_PASSWORD") {
    throw new ApiError(400, "INVALID_TOKEN", "That reset link is invalid. Request a new one.");
  }
  if (record.usedAt) throw new ApiError(400, "INVALID_TOKEN", "That reset link was already used.");
  if (record.expiresAt < new Date()) throw new ApiError(400, "EXPIRED_TOKEN", "That reset link has expired.");
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.verificationToken.updateMany({
      where: { userId: record.userId, kind: "RESET_PASSWORD", usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);
  // SEC-7: a password reset revokes every outstanding session (stolen-cookie
  // defense) — the new session below is minted AFTER the version bump so it
  // carries the fresh ver.
  await revokeUserSessions(record.userId);
  const session = await createSessionToken(record.userId);
  return { session };
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const ROLE_ALLOWED = new Set([
  "Data Scientist",
  "Data Analyst",
  "Business Analyst",
  "Consultant",
  "Founder",
  "Executive",
  "Other",
]);

export async function completeOnboarding(
  userId: string,
  input: {
    profileRole: string;
    goals: string[];
    organization?: string;
    industry?: string;
    experience?: string;
    workspaceName?: string;
  },
) {
  if (!ROLE_ALLOWED.has(input.profileRole)) {
    throw new ApiError(400, "VALIDATION", "Please choose a valid role.");
  }
  const workspaceName = input.workspaceName?.trim() || `${input.profileRole} workspace`;
  const workspace = await prisma.user.findUnique({ where: { id: userId }, select: { workspace: true } });
  if (!workspace?.workspace)
    throw new ApiError(500, "NO_WORKSPACE", "Your workspace was not created. Please re-register.");
  await prisma.$transaction([
    prisma.workspace.update({
      where: { id: workspace.workspace.id },
      data: { name: workspaceName },
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        profileRole: input.profileRole,
        goals: stringifyJson(input.goals.slice(0, 8)),
        organization: input.organization?.trim() || null,
        industry: input.industry?.trim() || null,
        experience: input.experience || null,
        onboardedAt: new Date(),
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sessionCookieFor(token: string) {
  return createSessionCookie(token, SESSION_MAX_AGE);
}

export function safeUser(user: { id: string; email: string; name: string; profileRole: string | null }) {
  return { id: user.id, email: user.email, name: user.name, profileRole: user.profileRole };
}
