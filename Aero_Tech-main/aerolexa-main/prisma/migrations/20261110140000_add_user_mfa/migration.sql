-- TOTP MFA state. The seed is sealed at rest (AUTH_SECRET), recovery codes are
-- bcrypt hashes, and mfaLastUsedStep prevents replay inside a 30-second window.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mfaLastUsedStep" INTEGER;
