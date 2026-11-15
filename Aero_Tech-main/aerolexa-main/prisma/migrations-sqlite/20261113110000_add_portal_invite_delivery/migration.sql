-- Invite delivery evidence: whether the magic link actually left the server.
-- The public request endpoint stays non-enumerating; the firm sees the outcome.
ALTER TABLE "ClientPortalLoginToken" ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "ClientPortalLoginToken" ADD COLUMN "deliveryError" TEXT;
ALTER TABLE "ClientPortalLoginToken" ADD COLUMN "deliveredAt" DATETIME;
