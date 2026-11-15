/**
 * Idle deferral — mount heavy decorative work only after the page is useful.
 *
 * The hero canvas is aria-hidden and purely decorative: deferring its WebGL
 * mount past first paint + idle keeps the Largest Contentful Paint provably
 * untouched (S4.2). `requestIdleCallback` is used where it exists with a
 * timeout cap so a perpetually-busy main thread cannot starve the scene
 * forever; the fallback schedules one short timeout, which fires strictly
 * after the initial paint. Server-safe: no window, no scheduling, no throw.
 */

export function whenIdle(cb: () => void, timeoutMs = 600): () => void {
  if (typeof window === "undefined") return () => undefined;

  const w = window as typeof window & {
    requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(() => cb(), { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(handle);
  }

  const timer = window.setTimeout(cb, Math.min(timeoutMs, 200));
  return () => window.clearTimeout(timer);
}
