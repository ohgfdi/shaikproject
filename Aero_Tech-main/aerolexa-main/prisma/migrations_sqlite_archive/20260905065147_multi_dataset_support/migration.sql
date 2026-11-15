-- CreateTable
CREATE TABLE "AnalysisDataset" (
    "analysisId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("analysisId", "datasetId"),
    CONSTRAINT "AnalysisDataset_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnalysisDataset_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotebookDataset" (
    "notebookId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("notebookId", "datasetId"),
    CONSTRAINT "NotebookDataset_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "Notebook" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotebookDataset_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectJoinMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "leftDatasetId" TEXT NOT NULL,
    "leftColumn" TEXT NOT NULL,
    "leftType" TEXT NOT NULL,
    "rightDatasetId" TEXT NOT NULL,
    "rightColumn" TEXT NOT NULL,
    "rightType" TEXT NOT NULL,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectJoinMapping_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectJoinMapping_leftDatasetId_fkey" FOREIGN KEY ("leftDatasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectJoinMapping_rightDatasetId_fkey" FOREIGN KEY ("rightDatasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatasetProvenance" (
    "derivedDatasetId" TEXT NOT NULL,
    "sourceDatasetId" TEXT NOT NULL,
    "query" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("derivedDatasetId", "sourceDatasetId"),
    CONSTRAINT "DatasetProvenance_derivedDatasetId_fkey" FOREIGN KEY ("derivedDatasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatasetProvenance_sourceDatasetId_fkey" FOREIGN KEY ("sourceDatasetId") REFERENCES "Dataset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AnalysisDataset_datasetId_idx" ON "AnalysisDataset"("datasetId");

-- CreateIndex
CREATE INDEX "NotebookDataset_datasetId_idx" ON "NotebookDataset"("datasetId");

-- CreateIndex
CREATE INDEX "ProjectJoinMapping_workspaceId_projectId_idx" ON "ProjectJoinMapping"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "DatasetProvenance_sourceDatasetId_idx" ON "DatasetProvenance"("sourceDatasetId");
