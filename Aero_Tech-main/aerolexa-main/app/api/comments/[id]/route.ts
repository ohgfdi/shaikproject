import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";
import { requireRowRole } from "@/lib/server/members";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();
    const comment = await prisma.comment.findUnique({ where: { id: params.id } });
    if (!comment) throw new ApiError(404, "NOT_FOUND", "Comment not found.");
    // Authors may delete their own comment; others need EDITOR on the project.
    const isAuthor = comment.authorId === ctx.user.id;
    if (!isAuthor) {
      await requireRowRole(ctx, comment, "EDITOR");
    }
    // Cascade removes replies.
    await prisma.comment.delete({ where: { id: comment.id } });
    return ok({ deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
