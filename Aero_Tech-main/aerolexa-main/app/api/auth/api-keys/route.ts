import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { hashApiKey, generateApiKey } from "@/lib/server/api-keys";
import { requireApiKeyAvailable, requireEntitlement } from "@/lib/server/entitlements";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Parse ?page=&pageSize= defensively; 1-based page numbers. */
function parsePagination(url: URL): { page: number; pageSize: number; skip: number } {
  const rawPage = Number(url.searchParams.get("page") ?? 1);
  const rawSize = Number(url.searchParams.get("pageSize") ?? DEFAULT_PAGE_SIZE);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(Math.floor(rawSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * GET /api/auth/api-keys?page=1&pageSize=20
 *
 * List the current user's API keys, paginated, with the total count for
 * pagination UI. Response: { apiKeys, page, pageSize, total, totalPages }.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAuth();
    const { page, pageSize, skip } = parsePagination(new URL(request.url));

    const where = { userId: ctx.user.id };
    const [total, keys] = await Promise.all([
      prisma.userApiKey.count({ where }),
      prisma.userApiKey.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          rateLimit: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return ok({
      apiKeys: keys.map((k) => ({
        ...k,
        scopes: JSON.parse(k.scopes || "[]"),
      })),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/auth/api-keys
 *
 * Create a new API key.
 * Body: { name, scopes?, rateLimit?, expiresInDays? }
 * Returns the plaintext key ONCE (with prefix).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();

    const body = await readJsonBody<{
      name?: string;
      scopes?: string[];
      rateLimit?: number;
      expiresInDays?: number;
    }>(request);

    const name = (body.name ?? "").trim();
    if (!name) throw new ApiError(400, "VALIDATION", "Name is required.");
    if (name.length > 100) throw new ApiError(400, "VALIDATION", "Name too long (max 100 characters).");

    // Programmatic distribution is a Pro/Firm entitlement — free workspaces
    // use the UI. (The key's scope checks still apply on every request.)
    await requireEntitlement(ctx.workspace.id, "apiKeys", { feature: "API keys" });
    await requireApiKeyAvailable(ctx.workspace.id);

    const scopes = body.scopes ?? ["datasets:read", "reports:read"];
    // No wildcard scope: a key carries exactly the permissions it was granted,
    // so it can never be used to escalate beyond the list below.
    const validScopes = [
      "datasets:read",
      "datasets:write",
      "reports:read",
      "reports:write",
      "execute:dax",
      "execute:sql",
      "notebooks:read",
      "notebooks:write",
      "metrics:read",
    ];
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new ApiError(400, "VALIDATION", "Grant at least one scope.");
    }
    for (const s of scopes) {
      if (typeof s !== "string" || !validScopes.includes(s)) {
        throw new ApiError(400, "VALIDATION", `Invalid scope: ${String(s)}`);
      }
    }

    const rateLimit = body.rateLimit ?? 60;
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000) {
      throw new ApiError(400, "VALIDATION", "Rate limit must be a whole number between 1 and 1000.");
    }

    let expiresAt: Date | null = null;
    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
      const days = Number(body.expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        throw new ApiError(400, "VALIDATION", "Expiry must be between 1 and 3650 days.");
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }

    // Generate API key
    const { key, prefix, secret: _secret } = generateApiKey();
    const keyHash = await hashApiKey(key);

    const apiKey = await prisma.userApiKey.create({
      data: {
        userId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        name,
        keyHash,
        keyPrefix: prefix,
        scopes: JSON.stringify(scopes),
        rateLimit,
        expiresAt,
      },
    });

    // Return the full key only once
    return ok({
      id: apiKey.id,
      name: apiKey.name,
      key, // Full key: prefix + secret
      keyPrefix: apiKey.keyPrefix,
      scopes,
      rateLimit: apiKey.rateLimit,
      expiresAt: apiKey.expiresAt?.toISOString() ?? null,
      createdAt: apiKey.createdAt.toISOString(),
      warning: "Save this key now. It will not be shown again.",
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
