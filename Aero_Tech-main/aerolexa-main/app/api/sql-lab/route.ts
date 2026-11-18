import { requireAuth } from '@/lib/auth/guard';
import { ok, toErrorResponse } from '@/lib/server/api';
import { safeQuery } from '@/lib/server/sql-lab';

export async function POST(request: Request) {
  try {
    const ctx = await requireAuth();

    const body = await request.json();
    const { query } = body as { query: string };

    if (!query || query.trim().length === 0) {
      return toErrorResponse(new Error('Missing: query'));
    }

    // Execute safely using the SQL lab utility
    const result = await safeQuery(query);

    if (!result.success) {
      return toErrorResponse(new Error(result.error || 'Query failed'));
    }

    return ok({ ...result, executedBy: ctx.user?.id || 'unknown' });
  } catch (err: any) {
    return toErrorResponse(err);
  }
}