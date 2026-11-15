import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { requireRowRole, type ArtifactRow } from "@/lib/server/members";
import type { CommentThreadItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const TARGET_KEYS = ["analysis", "dashboard", "report", "presentation", "insight", "dataset"] as const;

export type CommentTargetType = (typeof TARGET_KEYS)[number];

async function resolveTarget(
  targetType: CommentTargetType,
  targetId: string,
): Promise<(ArtifactRow & { id: string }) | null> {
  switch (targetType) {
    case "analysis":
      return await prisma.analysis.findUnique({ where: { id: targetId } });
    case "dashboard":
      return await prisma.dashboard.findUnique({ where: { id: targetId } });
    case "report":
      return await prisma.report.findUnique({ where: { id: targetId } });
    case "presentation":
      return await prisma.presentation.findUnique({ where: { id: targetId } });
    case "insight":
      return await prisma.insight.findUnique({ where: { id: targetId } });
    case "dataset":
      return await prisma.dataset.findUnique({ where: { id: targetId } });
    default:
      return null;
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const targetType = url.searchParams.get("targetType") as CommentTargetType | null;
    const targetId = url.searchParams.get("targetId") ?? "";
    if (!targetType || !(TARGET_KEYS as readonly string[]).includes(targetType)) {
      throw new ApiError(400, "VALIDATION", "Missing or invalid targetType.");
    }
    if (!targetId) throw new ApiError(400, "VALIDATION", "Missing targetId.");
    const target = await resolveTarget(targetType, targetId);
    if (!target) throw new ApiError(404, "NOT_FOUND", "Target not found.");
    await requireRowRole(ctx, target, "VIEWER");

    const rows = await prisma.comment.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: { author: { select: { id: true, name: true } } },
    });
    return ok({
      comments: rows.map(
        (c) =>
          ({
            id: c.id,
            authorName: c.author.name,
            authorId: c.authorId,
            body: c.body,
            createdAt: c.createdAt.toISOString(),
            parentId: c.parentId,
          }) as CommentThreadItem,
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await readJsonBody<{ targetType?: string; targetId?: string; body?: string; parentId?: string }>(
      request,
    );
    const targetType = (body.targetType ?? "") as CommentTargetType;
    if (!(TARGET_KEYS as readonly string[]).includes(targetType)) {
      throw new ApiError(400, "VALIDATION", "Missing or invalid targetType.");
    }
    const text = (body.body ?? "").trim();
    if (!text) throw new ApiError(400, "VALIDATION", "Write a comment first.");
    if (text.length > 5000) throw new ApiError(400, "VALIDATION", "Comments are limited to 5 000 characters.");
    const target = await resolveTarget(targetType, body.targetId ?? "");
    if (!target) throw new ApiError(404, "NOT_FOUND", "Target not found.");
    // VIEWERs may comment (spec permission matrix); replies must target an existing comment on the same target.
    await requireRowRole(ctx, target, "VIEWER");

    let parentId: string | null = body.parentId ?? null;
    if (parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (!parent || parent.targetType !== targetType || parent.targetId !== target.id) {
        throw new ApiError(400, "VALIDATION", "The reply target comment does not exist on this item.");
      }
    } else {
      parentId = null;
    }

    const comment = await prisma.comment.create({
      data: {
        workspaceId: ctx.workspace.id,
        projectId: (target as { projectId?: string | null }).projectId ?? null,
        authorId: ctx.user.id,
        targetType,
        targetId: target.id,
        body: text,
        parentId,
      },
    });
    await logActivity(
      ctx,
      "COMMENT_ADDED",
      `Comment added on ${targetType} ${target.id.slice(0, 8)}…`,
      (target as { projectId?: string | null }).projectId ?? null,
      { targetType, targetId: target.id, commentId: comment.id },
    );
    return ok({
      comment: {
        id: comment.id,
        authorName: ctx.user.name,
        authorId: ctx.user.id,
        body: text,
        createdAt: comment.createdAt.toISOString(),
        parentId: comment.parentId,
      } as CommentThreadItem,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
