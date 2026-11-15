/**
 * Account MFA service.
 *
 * Enrollment is two-step on purpose: `startMfaSetup` stores a sealed *pending*
 * seed, and `enableMfa` promotes it only after the user proves they can read a
 * code from it. That prevents locking someone out with a seed their
 * authenticator never actually received.
 *
 * Login verification accepts a TOTP code or a single-use recovery code. Both
 * paths are replay-safe: TOTP compares the accepted step, recovery codes are
 * removed from the stored set on use.
 */

import { ApiError } from "@/lib/auth/guard";
import {
  findRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
  openTotpSecret,
  otpauthUrl,
  recoveryCodesRemaining,
  sealTotpSecret,
  totpStep,
  verifyTotp,
} from "@/lib/auth/totp";
import { prisma } from "@/lib/db";

const ISSUER = "Ledgerly";

export interface MfaStatus {
  readonly enabled: boolean;
  readonly setupPending: boolean;
  readonly recoveryCodesRemaining: number;
}

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaEnabledAt: true, mfaPendingSecret: true, mfaRecoveryCodes: true },
  });
  if (!user) throw new ApiError(404, "NOT_FOUND", "Account not found.");
  return {
    enabled: Boolean(user.mfaEnabledAt),
    setupPending: Boolean(user.mfaPendingSecret) && !user.mfaEnabledAt,
    recoveryCodesRemaining: recoveryCodesRemaining(user.mfaRecoveryCodes),
  };
}

/** Generate and store a pending seed; returns it plus the otpauth URI. */
export async function startMfaSetup(
  userId: string,
): Promise<{ secret: string; otpauthUrl: string; issuer: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, mfaEnabledAt: true },
  });
  if (!user) throw new ApiError(404, "NOT_FOUND", "Account not found.");
  if (user.mfaEnabledAt) {
    throw new ApiError(409, "MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled. Disable it first to re-enrol.");
  }
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { mfaPendingSecret: sealTotpSecret(secret) },
  });
  return { secret, otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: ISSUER }), issuer: ISSUER };
}

/**
 * Promote the pending seed after a valid code. Returns the recovery codes in
 * plaintext exactly once; only bcrypt hashes are stored.
 */
export async function enableMfa(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaPendingSecret: true, mfaEnabledAt: true },
  });
  if (!user) throw new ApiError(404, "NOT_FOUND", "Account not found.");
  if (user.mfaEnabledAt) throw new ApiError(409, "MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled.");
  if (!user.mfaPendingSecret) {
    throw new ApiError(400, "MFA_SETUP_NOT_STARTED", "Start two-factor setup before entering a code.");
  }

  let secret: string;
  try {
    secret = openTotpSecret(user.mfaPendingSecret);
  } catch {
    throw new ApiError(500, "MFA_SECRET_UNREADABLE", "The pending MFA secret could not be read. Start setup again.");
  }
  const verified = verifyTotp(secret, code, { window: 1 });
  if (!verified.valid) {
    throw new ApiError(400, "INVALID_MFA_CODE", "That code is not valid. Check your authenticator app and try again.");
  }

  const recoveryCodes = generateRecoveryCodes(10);
  const hashes = await hashRecoveryCodes(recoveryCodes);
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaSecret: sealTotpSecret(secret),
      mfaPendingSecret: null,
      mfaEnabledAt: new Date(),
      mfaRecoveryCodes: JSON.stringify(hashes),
      mfaLastUsedStep: verified.step,
    },
  });
  return { recoveryCodes };
}

/** Disable MFA after proving possession of a current TOTP or recovery code. */
export async function disableMfa(userId: string, code: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, mfaEnabledAt: true, mfaSecret: true, mfaRecoveryCodes: true, mfaLastUsedStep: true },
  });
  if (!user) throw new ApiError(404, "NOT_FOUND", "Account not found.");
  if (!user.mfaEnabledAt || !user.mfaSecret) {
    throw new ApiError(409, "MFA_NOT_ENABLED", "Two-factor authentication is not enabled.");
  }
  const accepted = await verifyMfaCode(user, code);
  if (!accepted) {
    throw new ApiError(401, "INVALID_MFA_CODE", "That code is invalid or has already been used.");
  }
  await prisma.user.update({
    where: { id: userId },
    data: { mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: null, mfaLastUsedStep: null },
  });
}

interface MfaUserRow {
  readonly id: string;
  readonly mfaSecret: string | null;
  readonly mfaRecoveryCodes: string | null;
  readonly mfaLastUsedStep: number | null;
}

/**
 * Verify a login/disable code and consume it. Returns false for a wrong or
 * replayed code; throws only when the account is not enrolled.
 */
async function verifyMfaCode(user: MfaUserRow, code: string): Promise<boolean> {
  if (!user.mfaSecret) return false;
  let secret: string;
  try {
    secret = openTotpSecret(user.mfaSecret);
  } catch {
    throw new ApiError(500, "MFA_SECRET_UNREADABLE", "The stored MFA secret could not be read. Contact an operator.");
  }

  const totp = verifyTotp(secret, code, { window: 1, lastUsedStep: user.mfaLastUsedStep });
  if (totp.valid && totp.step != null) {
    await prisma.user.update({ where: { id: user.id }, data: { mfaLastUsedStep: totp.step } });
    return true;
  }

  const hashes = parseRecoveryHashes(user.mfaRecoveryCodes);
  const index = await findRecoveryCode(code, hashes);
  if (index < 0) return false;
  const remaining = hashes.filter((_, position) => position !== index);
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaRecoveryCodes: JSON.stringify(remaining) },
  });
  return true;
}

/** Verify the MFA challenge's code and return the signed-in user. */
export async function verifyMfaLogin(
  userId: string,
  code: string,
): Promise<{ id: string; email: string; name: string; profileRole: string | null; workspaceId: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      profileRole: true,
      workspaceId: true,
      mfaEnabledAt: true,
      mfaSecret: true,
      mfaRecoveryCodes: true,
      mfaLastUsedStep: true,
    },
  });
  if (!user) throw new ApiError(401, "INVALID_MFA_CHALLENGE", "Sign in again to continue.");
  if (!user.mfaEnabledAt || !user.mfaSecret) {
    throw new ApiError(401, "MFA_NOT_ENABLED", "Two-factor authentication is not enabled for this account.");
  }
  const accepted = await verifyMfaCode(user, code);
  if (!accepted) {
    throw new ApiError(401, "INVALID_MFA_CODE", "That code is invalid or has already been used.");
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    profileRole: user.profileRole,
    workspaceId: user.workspaceId,
  };
}

/** Current TOTP step, exposed for tests and audit notes. */
export function currentMfaStep(now = Date.now()): number {
  return totpStep(now);
}

function parseRecoveryHashes(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
