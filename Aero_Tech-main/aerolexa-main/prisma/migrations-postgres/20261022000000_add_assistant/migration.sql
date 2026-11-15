-- Books assistant Phase 2: append-only run/tool-call log (PostgreSQL).
-- Mirrors prisma/migrations-sqlite/20261022000000_add_assistant.

CREATE TABLE IF NOT EXISTS "AssistantRun" (
    "id" TEXT NOT NULL,
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
    "costUsd" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "promptVersion" TEXT NOT NULL DEFAULT 'phase2-v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "AssistantRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantToolCall" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantToolCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AssistantOrganizationSetting" (
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantOrganizationSetting_pkey" PRIMARY KEY ("organizationId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantRun_requestId_key" ON "AssistantRun"("requestId");
CREATE INDEX IF NOT EXISTS "AssistantRun_workspaceId_createdAt_idx" ON "AssistantRun"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantRun_organizationId_createdAt_idx" ON "AssistantRun"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantRun_createdAt_idx" ON "AssistantRun"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantRun_userId_idempotencyKey_key" ON "AssistantRun"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "AssistantToolCall_runId_idx" ON "AssistantToolCall"("runId");
CREATE INDEX IF NOT EXISTS "AssistantToolCall_toolName_createdAt_idx" ON "AssistantToolCall"("toolName", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantToolCall_runId_seq_key" ON "AssistantToolCall"("runId", "seq");

DO $$ BEGIN
  ALTER TABLE "AssistantToolCall" ADD CONSTRAINT "AssistantToolCall_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "AssistantRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
