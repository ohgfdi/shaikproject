-- TOTP MFA state. The seed is sealed at rest (AUTH_SECRET), recovery codes are
-- bcrypt hashes, and mfaLastUsedStep prevents replay inside a 30-second window.
ALTER TABLE "User" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaPendingSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaEnabledAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "mfaRecoveryCodes" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaLastUsedStep" INTEGER;
