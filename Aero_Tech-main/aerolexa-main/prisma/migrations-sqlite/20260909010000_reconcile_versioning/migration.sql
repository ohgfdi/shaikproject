/*
 * Reconcile the versioning tables with the current Prisma schema.
 *
 * History: migration 20260905092143 created DatasetVersion (snapshotPath,
 * previousVersionId chain) + AnalysisVersion (kind/title) and failed-followup
 * 20260905093000 was rolled back. The schema has since converged on
 * self-describing snapshots (ndjsonPath + columns + profile +
 * qualityWarnings). Existing snapshots stay retrievable: the legacy
 * `snapshotPath` column is renamed to `ndjsonPath` (data preserved), and the
 * self-describing columns are added nullable-safe for existing rows.
 */

-- DatasetVersion: adopt the self-describing snapshot format in place.
ALTER TABLE "DatasetVersion" RENAME COLUMN "snapshotPath" TO "ndjsonPath";
ALTER TABLE "DatasetVersion" ADD COLUMN "columns" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "DatasetVersion" ADD COLUMN "profile" TEXT;
ALTER TABLE "DatasetVersion" ADD COLUMN "qualityWarnings" TEXT;

-- AnalysisVersion: align index naming with the schema's @@index directives
-- (old: ..._idx names, schema: unique keys + this index set).
DROP INDEX IF EXISTS "AnalysisVersion_workspaceId_analysisId_idx";
DROP INDEX IF EXISTS "AnalysisVersion_analysisId_version_idx";
DROP INDEX IF EXISTS "DatasetVersion_datasetId_version_idx";
DROP INDEX IF EXISTS "DatasetVersion_workspaceId_datasetId_idx";
CREATE INDEX "AnalysisVersion_workspaceId_analysisId_createdAt_idx" ON "AnalysisVersion"("workspaceId", "analysisId", "createdAt");
CREATE UNIQUE INDEX "AnalysisVersion_analysisId_version_key" ON "AnalysisVersion"("analysisId", "version");
CREATE INDEX "DatasetVersion_workspaceId_datasetId_createdAt_idx" ON "DatasetVersion"("workspaceId", "datasetId", "createdAt");
CREATE UNIQUE INDEX "DatasetVersion_datasetId_version_key" ON "DatasetVersion"("datasetId", "version");

-- NotebookVersion table (Phase 1.5 notebook snapshots)
CREATE TABLE IF NOT EXISTS "NotebookVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotebookVersion_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotebookVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "NotebookVersion_workspaceId_notebookId_createdAt_idx" ON "NotebookVersion"("workspaceId", "notebookId", "createdAt");
