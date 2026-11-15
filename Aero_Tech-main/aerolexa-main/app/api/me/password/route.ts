import { z } from "zod";

import { requireAuth, ApiError } from "@/lib/auth/guard";
import { verifyPassword, hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse, readJsonBody } from "@/lib/server/api";

const schema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) });

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();
    const body = schema.parse(await readJsonBody(request));
    const user = await prisma.user.findUnique({ where: { id: ctx.user.id } });
    if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in again.");
    const okPw = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!okPw) throw new ApiError(400, "WRONG_PASSWORD", "Your current password is incorrect.");
    const strength = validatePasswordStrength(body.newPassword);
    if (!strength.ok) throw new ApiError(400, "VALIDATION", strength.message ?? "Password too weak.");
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
    return ok({ changed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
