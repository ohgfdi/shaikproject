/**
 * Phase 16: Redis Caching
 *
 * Server-side caching for query results, session data, and frequently accessed
 * assets. Uses Redis for fast in-memory storage with TTL-based expiration.
 *
 * Usage:
 *   import { cacheGet, cacheSet, cacheInvalidate } from "@/lib/performance/redis-cache";
 *
 *   // Cache query results for 5 minutes
 *   const result = await cacheGet(`query:datasets:${workspaceId}`, async () => {
 *     return await prisma.dataset.findMany({ where: { workspaceId } });
 *   });
 *
 *   // Invalidate cache after data change
 *   await cacheInvalidate(`query:datasets:${workspaceId}`);
 */
import { createClient, RedisClientType } from "redis";

let redisClient: RedisClientType | null = null;

/** Initialize Redis client. */
export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient) {
    return redisClient;
  }

  const url = process.env.REDIS_URL || "redis://localhost:6379";

  try {
    redisClient = createClient({ url });
    await redisClient.connect();
    console.log("Redis client connected successfully");

    // Set up graceful shutdown
    process.on("SIGTERM", async () => {
      await redisClient.quit();
      process.exit(0);
    });

    process.on("SIGINT", async () => {
      await redisClient.quit();
      process.exit(0);
    });

    return redisClient;
  } catch (error) {
    console.warn("Redis client initialization failed, using memory cache", error);
    redisClient = null;
    // Return a mock client that falls back to memory
    return getMemoryClient();
  }
}

/** In-memory fallback cache. */
const memoryStore = new Map<string | symbol, { value: unknown; expiresAt: number }>();

function getMemoryClient(): RedisClientType {
  const mock: RedisClientType = {
    /** Get a value from cache. */
    async get(key: string) {
      const entry = memoryStore.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        return entry.value as string;
      }
      if (entry && entry.expiresAt <= Date.now()) {
        memoryStore.delete(key);
      }
      return null;
    },

    /** Set a value in cache with TTL. */
    async set(key: string, value: string | number, ttlMs: number) {
      memoryStore.set(key, {
        value,
        expiresAt: Date.now() + (ttlMs ?? 300000), // 5 min default
      });
    },

    /** Delete a key from cache. */
    async del(key: string) {
      memoryStore.delete(key);
    },

    /** Exists check. */
    async exists(key: string) {
      const entry = memoryStore.get(key);
      return entry && entry.expiresAt > Date.now();
    },

    /** TTL check. */
    async ttl(key: string) {
      const entry = memoryStore.get(key);
      if (entry && entry.expiresAt > Date.now()) {
        return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
      }
      return -1;
    },

    /** Ping to check connection. */
    async ping() {
      return "PONG";
    },

    /** Quit/close connection. */
    async quit() {
      // No-op for memory client
    },
  };

  return mock;
}

/** Cache a value with TTL. */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlMs: number = 300000 // 5 minutes default
): Promise<void> {
  const client = await getRedisClient();
  await client.set(key, JSON.stringify(value), ttlMs);
}

/** Get a cached value, or execute fallback if not cached. */
export async function cacheGet<
  T = unknown,
>(
  key: string,
  fallback: () => Promise<T>,
  ttlMs: number = 300000
): Promise<T | null> {
  const client = await getRedisClient();
  const cached = await client.get(key);

  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // Corrupted cache, fall through to fallback
    }
  }

  const result = await fallback();
  await client.set(key, JSON.stringify(result), ttlMs);
  return result;
}

/** Invalidate a cached key. */
export async function cacheInvalidate(key: string): Promise<void> {
  const client = await getRedisClient();
  await client.del(key);
}

/** Invalidate all cache keys matching a pattern. */
export async function cacheInvalidatePattern(
  pattern: string
): Promise<number> {
  const client = await getRedisClient();
  // Simplified - in production use SCAN command
  const keys = await client.keys(`${pattern}:*`);
  if (keys.length > 0) {
    await client.del(...keys);
  }
  return keys.length;
}

/** Cache query results for dashboard data. */
export async function cacheDashboardData(
  workspaceId: string,
  key: string,
  fallback: () => Promise<unknown>,
  ttlMs: number = 600000 // 10 minutes
): Promise<unknown> {
  const cacheKey = `dashboard:${workspaceId}:${key}`;
  return await cacheGet(cacheKey, fallback, ttlMs);
}

/** Invalidate all dashboard data for a workspace. */
export async function invalidateWorkspaceCache(workspaceId: string): Promise<void> {
  await cacheInvalidatePattern(`dashboard:${workspaceId}`);
}