import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { deadlineStatus } from "@/lib/engine/deadlines";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import {
  AUTHORITY_LEVELS,
  NOTICE_PRIORITIES,
  NOTICE_STATUSES,
  NOTICE_TYPES,
  createNotice,
  listNotices,
  toEngineNotice,
} from "@/lib/server/gst-notices";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  noticeNumber: z.string().trim().min(1),
  noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  noticeType: z.enum(NOTICE_TYPES as unknown as [string, ...string[]]),
  authorityLevel: z.enum(AUTHORITY_LEVELS as unknown as [string, ...string[]]),
  authorityName: z.string().trim().min(1),
  authorityJurisdiction: z.string().trim().min(1),
  gstin: z.string().trim().length(15),
  entityName: z.string().trim().min(1),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable()
    .optional(),
  financialYear: z.string().trim().max(12).nullable().optional(),
  subject: z.string().trim().min(1),
  description: z.string().trim().min(1),
  sections: z.array(z.string().trim().min(1)).max(40),
  rules: z.array(z.string().trim().min(1)).max(40),
  // Rupees at the API boundary; the store converts to minor units.
  demandedTax: z.number().finite().min(0).optional(),
  demandedInterest: z.number().finite().min(0).optional(),
  demandedPenalty: z.number().finite().min(0).optional(),
  responseDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(NOTICE_STATUSES as unknown as [string, ...string[]]).optional(),
  assignedTo: z.string().trim().max(200).nullable().optional(),
  priority: z.enum(NOTICE_PRIORITIES).optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
  bookId: z.string().trim().min(1).nullable().optional(),
});

/**
 * GET /api/gst/notices — the firm's notice register with a live deadline.
 * Every row carries the engine's `GstNotice` shape so the worklist and the
 * response generator consume exactly what the database holds.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const url = new URL(request.url);
    const rows = await listNotices(ctx.workspace.id, {
      status: url.searchParams.get("status") ?? undefined,
      gstin: url.searchParams.get("gstin") ?? undefined,
      bookId: url.searchParams.get("bookId") ?? undefined,
    });
    const today = new Date().toISOString().slice(0, 10);
    return ok({
      notices: rows.map((row) => ({
        ...row,
        notice: toEngineNotice(row),
        deadline: deadlineStatus(row.responseDueDate, today),
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/gst/notices — record a notice with its response deadline. */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = createSchema.parse(await readJsonBody<unknown>(request));
    const toMinor = (rupees: number | undefined) => (rupees === undefined ? undefined : Math.round(rupees * 100));
    const notice = await createNotice(ctx.workspace.id, {
      ...body,
      noticeType: body.noticeType as (typeof NOTICE_TYPES)[number],
      authorityLevel: body.authorityLevel as (typeof AUTHORITY_LEVELS)[number],
      status: body.status as (typeof NOTICE_STATUSES)[number] | undefined,
      demandedTax: toMinor(body.demandedTax),
      demandedInterest: toMinor(body.demandedInterest),
      demandedPenalty: toMinor(body.demandedPenalty),
    });
    return ok({ notice }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
