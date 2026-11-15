-- Notebook publishing (Hex-style data apps).
-- Workspace-authenticated by default; an OWNER can opt in to a public
-- view-only link keyed by a random shareToken.

ALTER TABLE "Notebook" ADD COLUMN "accessMode" TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE "Notebook" ADD COLUMN "shareToken" TEXT;
ALTER TABLE "Notebook" ADD COLUMN "publishedAt" DATETIME;
CREATE UNIQUE INDEX "Notebook_shareToken_key" ON "Notebook"("shareToken");