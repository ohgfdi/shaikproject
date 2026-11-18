import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { fingerprint, toReport } from "@/lib/server/error-tracking";
import { log, currentRequestId } from "@/lib/server/logger";

export const dynamic = "force-dynamic";

/** POST: Capture a application error (redacted, fingerprinted). */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = await request.json();

    // Accept either a full ErrorReport or raw error + context
    const report = z
      .object({
        fingerprint: z.string().optional(),
        name: z.string().optional(),
        message: z.string().optional(),
        stack: z.string().optional(),
        path: z.string().optional(),
        requestId: z.string().optional(),
        userId: z.string().optional(),
        workspaceId: z.string().optional(),
        severity: z.enum(["critical", "high", "medium", "low"]).optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        timestamp: z.number().optional(),
      })
      .passthrough();

    const parsed = report.safeParse(body);
    const base = parsed.success
      ? {
          fingerprint:
            parsed.data.fingerprint ??
            fingerprint(parsed.data.name ?? "Error", parsed.data.stack ?? ""),
          name: parsed.data.name ?? "Error",
          message: parsed.data.message ?? "",
          stack: parsed.data.stack ?? "",
          path: parsed.data.path ?? "",
          requestId: parsed.data.requestId,
          userId: parsed.data.userId ?? ctx.user.id,
          workspaceId: parsed.data.workspaceId ?? ctx.workspace.id,
        }
      : toReport(body.err, {
          path: body.path,
          requestId: currentRequestId() ?? undefined,
          userId: ctx.user.id,
          workspaceId: ctx.workspace.id,
        });

    // Upsert: de-duplicate by fingerprint, update lastSeenAt + count
    const existing = await prisma.errorReport.findFirst({
      where: { fingerprint: base.fingerprint },
    });

    const now = new Date();

    if (existing) {
      await prisma.errorReport.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: now,
          count: existing.count + 1,
          resolvedAt: null, // reset unless manually resolved via admin UI
        },
      });
    } else {
      await prisma.errorReport.create({
        data: {
          ...base,
          firstSeenAt: now,
          lastSeenAt: now,
          count: 1,
          resolvedAt: null,
        },
      });
    }

    log.info("error: captured", {
      fingerprint: base.fingerprint,
      count: existing ? existing.count + 1 : 1,
    });

    return ok({ fingerprint: base.fingerprint });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** GET: List fingerprinted errors with optional filtering. */
export async function GET(request: Request) {
  try {
    const _ctx = await requireAuth();

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor") ?? undefined;
    const limit = Math.min(
      Number(searchParams.get("limit") ?? "50"),
      200,
    );
    const resolved = searchParams.get("resolved") === "true";
    const severity = searchParams.get("severity") as "critical" | "high" | "medium" | "low" | undefined;
    const category = searchParams.get("category") ?? undefined;
    const tag = searchParams.get("tag") ?? undefined;

    const where = {
      resolvedAt: resolved ? { not: null } : null,
      ...(severity && { severity }),
      ...(category && { category }),
      ...(tag && { tags: { has: tag } }),
    };

    const total = await prisma.errorReport.count({ where });

    const all = await prisma.errorReport.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      take: limit + 1,
      skip: cursor ? 1 : 0,
    });

    const hasMore = all.length > limit;
    const page = all.slice(0, limit);
    const nextCursor = hasMore ? page[page.length - 1]?.fingerprint : undefined;

    return ok({
      reports: page.map((r) => ({
        fingerprint: r.fingerprint,
        name: r.name,
        message: r.message,
        stack: r.stack,
        path: r.path,
        requestId: r.requestId,
        userId: r.userId,
        workspaceId: r.workspaceId,
        severity: r.severity,
        category: r.category,
        tags: r.tags,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        count: r.count,
        resolvedAt: r.resolvedAt,
      })),
      total,
      nextCursor,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}