import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, toErrorResponse } from "@/lib/server/api";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/auth/api-keys/[keyId]
 *
 * Revoke (soft delete) an API key.
 */
export async function DELETE(_request: Request, props: { params: Promise<{ keyId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();

    const apiKey = await prisma.userApiKey.findUnique({
      where: { id: params.keyId },
    });
    if (!apiKey) throw new ApiError(404, "NOT_FOUND", "API key not found.");
    // Ownership check uses NOT_FOUND (not 403): a foreign key id must not leak
    // that the key exists — same convention as the publish-authz guard.
    if (apiKey.userId !== ctx.user.id) throw new ApiError(404, "NOT_FOUND", "API key not found.");
    if (apiKey.revokedAt) throw new ApiError(409, "ALREADY_REVOKED", "This API key is already revoked.");

    await prisma.userApiKey.update({
      where: { id: params.keyId },
      data: { revokedAt: new Date() },
    });

    return ok({ success: true, message: "API key revoked" });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/auth/api-keys/[keyId]
 *
 * Regenerate an API key: revokes the old key and issues a new one with the
 * same settings. Both writes run in ONE transaction — a failure between them
 * would otherwise destroy the credential permanently.
 */
export async function POST(_request: Request, props: { params: Promise<{ keyId: string }> }) {
  const params = await props.params;
  try {
    const ctx = await requireAuth();

    const apiKey = await prisma.userApiKey.findUnique({
      where: { id: params.keyId },
    });
    if (!apiKey) throw new ApiError(404, "NOT_FOUND", "API key not found.");
    // NOT_FOUND for foreign keys (no existence leak), matching DELETE above.
    if (apiKey.userId !== ctx.user.id) throw new ApiError(404, "NOT_FOUND", "API key not found.");
    if (apiKey.revokedAt) throw new ApiError(409, "ALREADY_REVOKED", "Cannot regenerate a revoked key.");

    const { generateApiKey, hashApiKey } = await import("@/lib/server/api-keys");
    const { key, prefix } = generateApiKey();
    const keyHash = await hashApiKey(key);

    const newApiKey = await prisma.$transaction(async (tx) => {
      // Revoke the old key and insert its replacement atomically. The
      // replacement keeps the ORIGINAL workspace binding so regeneration can
      // never silently re-point a key at the caller's current workspace.
      await tx.userApiKey.update({
        where: { id: params.keyId },
        data: { revokedAt: new Date() },
      });
      return tx.userApiKey.create({
        data: {
          userId: ctx.user.id,
          workspaceId: apiKey.workspaceId,
          name: apiKey.name,
          keyHash,
          keyPrefix: prefix,
          scopes: apiKey.scopes,
          rateLimit: apiKey.rateLimit,
          expiresAt: apiKey.expiresAt,
        },
      });
    });

    return ok({
      id: newApiKey.id,
      name: newApiKey.name,
      key,
      keyPrefix: newApiKey.keyPrefix,
      scopes: JSON.parse(newApiKey.scopes || "[]"),
      rateLimit: newApiKey.rateLimit,
      expiresAt: newApiKey.expiresAt?.toISOString() ?? null,
      createdAt: newApiKey.createdAt.toISOString(),
      warning: "Save this key now. It will not be shown again.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
