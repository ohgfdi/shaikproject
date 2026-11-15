-- Add canonical audit filters (previously only stored inside `meta` JSON).

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN "targetType" TEXT;
ALTER TABLE "Activity" ADD COLUMN "targetId" TEXT;
ALTER TABLE "Activity" ADD COLUMN "runId" TEXT;

-- CreateIndex
CREATE INDEX "Activity_targetType_targetId_idx" ON "Activity"("targetType", "targetId");
CREATE INDEX "Activity_runId_idx" ON "Activity"("runId");