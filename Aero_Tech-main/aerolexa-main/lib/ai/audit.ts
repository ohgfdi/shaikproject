/**
 * Append-only assistant audit trail.
 *
 * Every run and every tool call is written before the model can use the
 * result. The log records hashes/summaries rather than a second copy of client
 * financial data. Personal identifiers in the question and tool inputs are
 * scrubbed by the caller; this module is the only writer.
 *
 * Retention: `assistantLogRetentionDays()` (default 90) is wired into the
 * existing retention sweep. There is no update/delete API.
 */

import { scrubText } from "@/lib/ai/redact";
import type { ToolAuditRecord } from "@/lib/ai/tools/executor";
import { prisma } from "@/lib/db";
import { serverEnv } from "@/lib/env";

export const ASSISTANT_PROMPT_VERSION = "phase2-v1";

export type AssistantRunStatus = "running" | "completed" | "verification_failed" | "failed" | "aborted" | "limit";

export interface CreateRunInput {
  requestId: string;
  idempotencyKey?: string | null;
  userId: string;
  workspaceId: string;
  organizationId?: string | null;
  bookId?: string | null;
  question: string;
}

export interface FinishRunInput {
  status: AssistantRunStatus;
  answer?: string | null;
  verification?: unknown;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  errorCode?: string | null;
}

export function assistantLogRetentionDays(): number {
  return serverEnv().ASSISTANT_LOG_RETENTION_DAYS;
}

export async function createAssistantRun(input: CreateRunInput) {
  return prisma.assistantRun.create({
    data: {
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey ?? null,
      userId: input.userId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId ?? null,
      bookId: input.bookId ?? null,
      question: scrubText(input.question.slice(0, serverEnv().ASSISTANT_MAX_QUESTION_CHARS)) ?? "",
      promptVersion: ASSISTANT_PROMPT_VERSION,
      status: "running",
    },
  });
}

export async function finishAssistantRun(runId: string, input: FinishRunInput) {
  return prisma.assistantRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      answer: input.answer ?? null,
      verification: input.verification === undefined ? null : JSON.stringify(input.verification),
      toolCallCount: input.toolCallCount,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd: input.costUsd,
      latencyMs: input.latencyMs,
      errorCode: input.errorCode ?? null,
      completedAt: new Date(),
    },
  });
}

export async function appendAssistantToolCall(runId: string, seq: number, record: ToolAuditRecord) {
  return prisma.assistantToolCall.create({
    data: {
      runId,
      seq,
      toolName: record.toolName,
      resultId: record.resultId,
      inputJson: JSON.stringify(record.input),
      outputSummary: record.outputSummary,
      outputHash: record.outputHash,
      ok: record.ok,
      errorCode: record.errorCode ?? null,
      latencyMs: record.latencyMs,
    },
  });
}

export async function findIdempotentRun(userId: string, idempotencyKey: string) {
  return prisma.assistantRun.findFirst({
    where: { userId, idempotencyKey },
    orderBy: { createdAt: "desc" },
  });
}
