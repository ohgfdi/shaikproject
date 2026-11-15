-- Invite delivery evidence: whether the magic link actually left the server.
-- The public request endpoint stays non-enumerating; the firm sees the outcome.
ALTER TABLE "ClientPortalLoginToken"
  ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "ClientPortalLoginToken"
  ADD COLUMN IF NOT EXISTS "deliveryError" TEXT;
ALTER TABLE "ClientPortalLoginToken"
  ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
