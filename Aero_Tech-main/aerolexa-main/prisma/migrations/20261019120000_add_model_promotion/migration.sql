-- Model promotion audit trail for ModelVersion (lib/engine/mlops.ts):
-- challenger/champion gate verdicts flip status (CHAMPION/RETIRED), and every
-- promotion is stamped with WHO promoted it and WHY (the gate reasons / the
-- operator note). Additive columns only — no existing data is touched.

ALTER TABLE "ModelVersion" ADD COLUMN "promotedAt" TIMESTAMP;
ALTER TABLE "ModelVersion" ADD COLUMN "promotedBy" TEXT;
ALTER TABLE "ModelVersion" ADD COLUMN "note" TEXT;
