-- CreateTable
CREATE TABLE "AssistantRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT,
    "bookId" TEXT,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "answer" TEXT,
    "verification" TEXT,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "promptVersion" TEXT NOT NULL DEFAULT 'phase2-v1',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "AssistantToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "outputSummary" TEXT NOT NULL,
    "outputHash" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AssistantRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssistantOrganizationSetting" (
    "organizationId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantRun_requestId_key" ON "AssistantRun"("requestId");

-- CreateIndex
CREATE INDEX "AssistantRun_workspaceId_createdAt_idx" ON "AssistantRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantRun_organizationId_createdAt_idx" ON "AssistantRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantRun_createdAt_idx" ON "AssistantRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantRun_userId_idempotencyKey_key" ON "AssistantRun"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AssistantToolCall_runId_idx" ON "AssistantToolCall"("runId");

-- CreateIndex
CREATE INDEX "AssistantToolCall_toolName_createdAt_idx" ON "AssistantToolCall"("toolName", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantToolCall_runId_seq_key" ON "AssistantToolCall"("runId", "seq");

