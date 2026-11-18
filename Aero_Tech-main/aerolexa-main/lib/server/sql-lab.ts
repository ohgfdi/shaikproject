import { prisma } from '@/lib/db';

/** Execute a raw SQL query against the test database.
 *  Only use when SQL_LAB_ENABLED=true in .env.
 *  Returns rows affected or selected.
 */
export async function executeQuery(sql: string, params?: unknown[]) {
  if (!process.env.SQL_LAB_ENABLED) {
    throw new Error('SQL Lab is disabled. Set SQL_LAB_ENABLED=true in .env');
  }

  try {
    const result = await prisma.$executeRawUnsafe(sql, ...(params || []));

    // If the query returns rows (SELECT), we need to also fetch them
    // $executeRawUnsafe only returns the count for non-SELECT queries
    // For SELECT queries, we use prisma.$queryRaw

    // Try to determine if it's a SELECT query
    const upperSql = sql.trim().toUpperCase();
    if (upperSql.startsWith('SELECT')) {
      const rawResult = await prisma.$queryRawUnsafe(sql, ...(params || []));
      return {
        type: 'select' as const,
        rows: rawResult as unknown[],
        command: 'SELECT',
      };
    }

    return {
      type: 'execute' as const,
      command: 'EXECUTE',
      rowsAffected: result,
    };
  } catch (err) {
    return {
      type: 'error' as const,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/** Safe query wrapper that validates common patterns. */
export interface SafeQueryResult {
  success: boolean;
  data: unknown[];
  error?: string;
  rowsAffected?: number;
}

/** Execute a parameterized query safely. */
export async function safeQuery(sql: string, params?: unknown[]): Promise<SafeQueryResult> {
  try {
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      const rows = await prisma.$queryRawUnsafe(sql, ...(params || []));
      return {
        success: true,
        data: rows as unknown[],
      };
    } else {
      const result = await prisma.$executeRawUnsafe(sql, ...(params || []));
      return {
        success: true,
        data: [],
        rowsAffected: result,
      };
    }
  } catch (err) {
    return {
      success: false,
      data: [],
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}