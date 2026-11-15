/**
 * Complex payloads are persisted as TEXT containing JSON so the Prisma schema
 * stays identical on SQLite (dev) and PostgreSQL (prod). These helpers add the
 * type safety back on read. Every call site passes an explicit fallback so a
 * missing/invalid payload degrades gracefully instead of throwing.
 */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonArray<T>(raw: string | null | undefined, fallback: T[] = []): T[] {
  const value = parseJson<unknown>(raw, null);
  return Array.isArray(value) ? (value as T[]) : fallback;
}

export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
