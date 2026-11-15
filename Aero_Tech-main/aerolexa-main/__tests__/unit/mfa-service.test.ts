/**
 * MFA service integration test (database-backed).
 *
 * Exercises the real flow end to end: pending seed → valid code → recovery
 * codes → password login returns a challenge (not a session) → TOTP login →
 * single-use recovery code → disable. This is the path a user actually takes.
 */
import { afterAll, describe, expect, it } from "@jest/globals";

import { hashPassword } from "@/lib/auth/password";
import { verifyMfaChallengeToken } from "@/lib/auth/session";
import { totp } from "@/lib/auth/totp";
import { prisma } from "@/lib/db";
import { loginUser } from "@/lib/server/auth-service";
import { disableMfa, enableMfa, mfaStatus, startMfaSetup, verifyMfaLogin } from "@/lib/server/mfa";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("MFA service", () => {
  it("enrols, challenges password login, accepts TOTP once, and consumes recovery codes", async () => {
    const email = `mfa-${Date.now()}@test.local`;
    const password = "Testpass123";
    const user = await prisma.user.create({
      data: { email, name: "MFA Test", passwordHash: await hashPassword(password) },
    });

    try {
      const setup = await startMfaSetup(user.id);
      expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
      expect(setup.otpauthUrl).toContain("otpauth://totp/");
      expect((await mfaStatus(user.id)).setupPending).toBe(true);

      const enabled = await enableMfa(user.id, totp(setup.secret));
      expect(enabled.recoveryCodes).toHaveLength(10);
      const status = await mfaStatus(user.id);
      expect(status.enabled).toBe(true);
      expect(status.recoveryCodesRemaining).toBe(10);

      // The seed is sealed at rest, not stored in the clear.
      const stored = await prisma.user.findUnique({
        where: { id: user.id },
        select: { mfaSecret: true, mfaRecoveryCodes: true },
      });
      expect(stored?.mfaSecret).not.toContain(setup.secret);
      expect(stored?.mfaRecoveryCodes).not.toContain(enabled.recoveryCodes[0]!);

      // Password success alone returns a challenge, never a session.
      const login = await loginUser({ email, password });
      expect(login.mfaRequired).toBe(true);
      expect(login.session).toBeNull();
      if (!login.challenge) throw new Error("expected an MFA challenge");
      expect(await verifyMfaChallengeToken(login.challenge)).toBe(user.id);

      // A different step than the enrolment code is accepted exactly once.
      const loginCode = totp(setup.secret, Date.now() + 30_000);
      const verified = await verifyMfaLogin(user.id, loginCode);
      expect(verified.id).toBe(user.id);
      await expect(verifyMfaLogin(user.id, loginCode)).rejects.toMatchObject({ code: "INVALID_MFA_CODE" });

      // Recovery code is single-use.
      const recovery = enabled.recoveryCodes[0]!;
      await expect(verifyMfaLogin(user.id, recovery)).resolves.toMatchObject({ id: user.id });
      expect((await mfaStatus(user.id)).recoveryCodesRemaining).toBe(9);
      await expect(verifyMfaLogin(user.id, recovery)).rejects.toMatchObject({ code: "INVALID_MFA_CODE" });

      await disableMfa(user.id, enabled.recoveryCodes[1]!);
      expect((await mfaStatus(user.id)).enabled).toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
  });
});
