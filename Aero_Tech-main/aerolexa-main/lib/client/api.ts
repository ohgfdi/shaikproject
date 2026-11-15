"use client";

import { CACHE_POLICIES, cachedGet, invalidate, type CachePolicy } from "@/lib/client/query-cache";

export { CACHE_POLICIES, invalidate, invalidateAll } from "@/lib/client/query-cache";
export type { CachePolicy } from "@/lib/client/query-cache";

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorShape;
}

/** JSON request helper. Throws ApiClientError with a user-safe message on failure. */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  const isForm = init?.body instanceof FormData;
  if (!isForm && init?.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers, cache: "no-store" });
  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    envelope = null;
  }
  if (!res.ok || !envelope?.ok) {
    const err = envelope?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "REQUEST_FAILED",
      err?.message ?? `Request failed (${res.status}).`,
      err?.details,
    );
  }
  return envelope.data as T;
}

/**
 * Cached GET. Identical to `api()` but routed through the client query cache,
 * so a read is reused until its TTL expires and concurrent identical requests
 * share one round trip.
 *
 * Only use this for GETs of data that is safe to reuse — the mutations must
 * call `invalidate()` (or use plain `api()`) so a stale value cannot outlive a
 * write. Anything the user is actively editing should keep using `api()`.
 */
export async function apiCached<T = unknown>(
  path: string,
  policy: CachePolicy = CACHE_POLICIES.none,
  init?: RequestInit,
): Promise<T> {
  return cachedGet<T>(path, () => api<T>(path, { ...init, method: "GET" }), policy);
}

/**
 * Mutating request. Performs the write and invalidates any cached reads under
 * `invalidates` so the next render refetches rather than showing stale data.
 *
 * This is the counterpart that keeps the cache honest — a mutation that does
 * not invalidate is the one way this cache could show a wrong number.
 */
export async function apiMutate<T = unknown>(
  path: string,
  init: RequestInit,
  invalidates: string | string[],
): Promise<T> {
  const result = await api<T>(path, init);
  for (const prefix of Array.isArray(invalidates) ? invalidates : [invalidates]) {
    invalidate(prefix);
  }
  return result;
}

/** Router-safe formatter for inline error copy. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}
