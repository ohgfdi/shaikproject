import { z } from "zod";

import { requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";

const schema = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() });

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    if (body.all) {
      await prisma.notification.updateMany({
        where: { userId: ctx.user.id, readAt: null },
        data: { readAt: new Date() },
      });
    } else if (body.ids?.length) {
      await prisma.notification.updateMany({
        where: { userId: ctx.user.id, id: { in: body.ids }, readAt: null },
        data: { readAt: new Date() },
      });
    }
    return ok({ updated: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
