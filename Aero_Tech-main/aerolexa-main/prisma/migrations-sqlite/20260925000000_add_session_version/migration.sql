-- Session revocation (SEC-7): per-user counter embedded in session JWTs.
-- Bumping it invalidates every outstanding session for that user immediately.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;
