/**
 * Touch gestures — the deterministic core of the mobile upgrades.
 *
 * Dependency-free so the gesture policy is unit-gated: what counts as a
 * swipe, when a drawer should open, when pull-to-refresh arms and fires.
 * The components (drawer, pull-to-refresh wrapper) compose these helpers
 * with real TouchEvents; the *decisions* live here and are testable.
 *
 * Thresholds follow the two-thumb mobile heuristics: horizontal swipes need
 * clear horizontal dominance (|dx| > |dy| * 1.5) so vertical page scrolls
 * never trigger them, and the pull-to-refresh gesture only arms while the
 * page is scrolled to the top.
 */

// ---------------------------------------------------------------------------
// Swipe detection
// ---------------------------------------------------------------------------

export type SwipeDirection = "left" | "right" | "up" | "down";

export interface TouchPoint {
  x: number;
  y: number;
}

export interface SwipeResult {
  direction: SwipeDirection;
  /** Gesture distance in px (always the dominant axis). */
  distance: number;
}

/** Default minimum distance for a swipe, in px. ~48px ≈ one thumb-width. */
export const SWIPE_MIN_DISTANCE = 48;

/**
 * Classify a completed touch gesture. Returns null when the movement is too
 * short, ambiguous (diagonal), or vertical-dominant for a horizontal intent.
 * `minDistance` lets edge cases (e.g. carousel) tighten the bar.
 */
export function classifySwipe(
  start: TouchPoint,
  end: TouchPoint,
  minDistance: number = SWIPE_MIN_DISTANCE,
): SwipeResult | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const distance = Math.max(absX, absY);
  if (distance < minDistance) return null;
  // Dominance: the intended axis must clearly win, otherwise the gesture is
  // ambiguous and must NOT fire (scroll wins).
  if (absX > absY * 1.5) return { direction: dx > 0 ? "right" : "left", distance: absX };
  if (absY > absX * 1.5) return { direction: dy > 0 ? "down" : "up", distance: absY };
  return null;
}

// ---------------------------------------------------------------------------
// Pull-to-refresh state machine
// ---------------------------------------------------------------------------

export type PullRefreshState = "idle" | "pulling" | "armed" | "refreshing";

/** Pull distance (px) at which release triggers the refresh. */
export const PULL_ARM_DISTANCE = 80;

export interface PullRefreshStateSpec {
  state: PullRefreshState;
  /** 0..1 progress for the indicator (clamped at 1 once armed). */
  progress: number;
}

/**
 * Advance the pull-to-refresh machine.
 *
 * @param state     current machine state
 * @param scrollY   current scroll offset — the gesture only arms at the top
 * @param pullPx    pull distance in px (clamped internally at 2× arm distance)
 * @param phase     "move" during the drag, "release" on touchend
 */
export function advancePullRefresh(
  state: PullRefreshState,
  scrollY: number,
  pullPx: number,
  phase: "move" | "release",
): PullRefreshStateSpec {
  if (state === "refreshing") {
    return { state: "refreshing", progress: 1 };
  }
  if (phase === "release") {
    if (state === "armed") return { state: "refreshing", progress: 1 };
    return { state: "idle", progress: 0 };
  }
  if (scrollY > 0) {
    // Not at the top — the pull is just an ordinary scroll.
    return state === "idle" ? { state: "idle", progress: 0 } : { state: "idle", progress: 0 };
  }
  const clamped = Math.max(0, Math.min(pullPx, PULL_ARM_DISTANCE * 2));
  if (clamped >= PULL_ARM_DISTANCE) return { state: "armed", progress: 1 };
  return { state: "pulling", progress: Math.round((clamped / PULL_ARM_DISTANCE) * 100) / 100 };
}

/** Reset the machine after the refresh work completes. */
export function finishPullRefresh(): PullRefreshStateSpec {
  return { state: "idle", progress: 0 };
}

// ---------------------------------------------------------------------------
// Responsive helpers (pure, for SSR-safe decisions and tests)
// ---------------------------------------------------------------------------

/** Tailwind `sm` breakpoint used across the shell (px). */
export const SM_BREAKPOINT = 640;

/**
 * Bottom-nav visibility contract: the fixed bottom bar renders below `sm`
 * and never above it — mirrored from the app shell's `sm:hidden` classes so
 * tests can pin the behaviour without a browser.
 */
export function showsBottomNav(viewportWidth: number): boolean {
  return viewportWidth < SM_BREAKPOINT;
}

/**
 * Sticky-offset contract for the mobile composer: the chat composer sits
 * above the bottom nav (h-14) when the bottom nav is visible, else flush.
 */
export function composerBottomOffset(viewportWidth: number): number {
  return showsBottomNav(viewportWidth) ? 56 : 0;
}
