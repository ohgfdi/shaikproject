/**
 * Phase 16: Query Optimization
 *
 * Provides Prisma query optimization utilities, index recommendations,
 * and query plan analysis for large-dataset performance.
 *
 * Usage:
 *   import { optimizePrismaQuery, analyzeQuery } from "@/lib/performance/query-optimizer";
 *
 *   // Optimized dataset query with proper filtering
 *   const datasets = await optimizePrismaQuery(prisma.dataset, {
 *     where: { workspaceId, status: "ACTIVE" },
 *     orderBy: { createdAt: "desc" },
 *     take: 50,
 *   });
 */
import { Prisma } from "@prisma/client";

/** Add commonly used WHERE filters as AND conditions. */
export function addCommonFilters<
  ModelName extends keyof Prisma.ModelTree,
>(
  prisma: Prisma.ModelRegistry[ModelName],
  args: Prisma.Args<ModelName, "findMany">,
  filters: {
    /** Only items created after this date */
    createdAfter?: Date;
    /** Only items created before this date */
    createdBefore?: Date;
    /** Only items with specific status */
    status?: string;
    /** Search in name field */
    search?: string;
  }
) {
  const where: any = {};

  if (filters.createdAfter) {
    where.createdAt = { gte: filters.createdAfter };
  }
  if (filters.createdBefore) {
    where.createdAt = {
      ...where.createdAt,
      lte: filters.createdBefore,
    };
  }
  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: "insensitive" } },
      { description: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  return { ...args, where };
}

/** Add ORDER BY with default fallback. */
export function addDefaultOrderBy<
  ModelName extends keyof Prisma.ModelTree,
>(
  args: Prisma.Args<ModelName, "findMany">,
  defaultField = "createdAt"
) {
  const orderBy: any = {};

  // Extract existing orderBy or use default
  if (args.orderBy) {
    orderBy[args.orderBy.field] = args.orderBy.direction;
  } else {
    orderBy[defaultField] = "desc";
  }

  return { ...args, orderBy };
}

/** Limit result set with pagination. */
export function addPagination<T>(
  items: T[],
  page: number,
  pageSize: number
): { data: T[]; total: number; totalPages: number; hasNext: boolean; hasPrev: boolean } {
  const total = items.length; // In production, pass total from count query
  const totalPages = Math.ceil(total / pageSize);
  const startIdx = (page - 1) * pageSize;
  const endIdx = startIdx + pageSize;

  const data = items.slice(startIdx, endIdx);

  return {
    data,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

/** Generate index recommendation based on query patterns. */
export function generateIndexRecommendation(
  modelName: string,
  queryFields: string[],
  sortFields: string[]
): string {
  const fields = [...new Set([...queryFields, ...sortFields])];
  const indexedFields = fields.filter(
    (field) => field.startsWith("-") || !field.startsWith("-")
  );

  // Generate Prisma schema index block
  const indexLines = indexedFields.map((field) => {
    const cleanField = field.startsWith("-") ? field.slice(1) : field;
    return `@@index([${cleanField}])`;
  });

  return `// Phase 16: Index recommendations for ${modelName}\n` +
    indexLines.join("\n") +
    `\n// Queried fields: ${queryFields.join(", ")}\n// Sorted fields: ${sortFields.join(", ")}`;
}

/** Query plan analyzer (simplified). */
export function analyzeQueryPerformance(
  query: string,
  executionTimeMs: number,
  rowCount: number
): {
  isPerformant: boolean;
  suggestions: string[];
} {
  const isPerformant = executionTimeMs < 500 && rowCount < 10000;

  const suggestions: string[] = [];

  if (!isPerformant) {
    if (executionTimeMs > 5000) {
      suggestions.push(
        "Consider adding WHERE clause to filter results early"
      );
    }
    if (rowCount > 10000) {
      suggestions.push(
        "Consider adding pagination (take/skip) or filtering"
      );
    }
    if (executionTimeMs > 1000) {
      suggestions.push("Add database indexes on filtered/sorted fields");
    }
  }

  return {
    isPerformant,
    suggestions,
  };
}