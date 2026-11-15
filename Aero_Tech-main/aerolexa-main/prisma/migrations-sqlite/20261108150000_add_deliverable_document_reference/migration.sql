-- Separate a real ICAI UDIN from an app-internal document reference.
-- `udin` now stores only a real 21-character UDIN captured from ICAI; the app
-- never mints one. `documentReference` is an internal tracking id and is never
-- rendered as a UDIN.
ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "documentReference" TEXT;
ALTER TABLE "EngagementDeliverableVersion" ADD COLUMN "udinSource" TEXT;

-- Legacy rows: before this change the app minted an internal 21-character id
-- into "udin"; none of those values is an ICAI-issued UDIN. Preserve them as
-- the internal document reference and clear the UDIN fields so nothing keeps
-- printing a minted id as a real UDIN.
UPDATE "EngagementDeliverableVersion"
SET "documentReference" = "udin",
    "udin" = NULL,
    "udinIssuedAt" = NULL
WHERE "udin" IS NOT NULL AND "documentReference" IS NULL;
