-- Document requests can now belong to an engagement (client portal), not only a
-- legacy workspace. A portal upload that answers a request records the link and
-- moves the request to received.
ALTER TABLE "ClientDocumentRequest" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "ClientDocumentRequest" ADD COLUMN "engagementId" TEXT;
ALTER TABLE "ClientDocumentRequest" ADD COLUMN "fulfilledByUploadId" TEXT;

CREATE INDEX "ClientDocumentRequest_engagementId_status_idx" ON "ClientDocumentRequest"("engagementId", "status");

ALTER TABLE "ClientDocumentRequest" ADD CONSTRAINT "ClientDocumentRequest_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
