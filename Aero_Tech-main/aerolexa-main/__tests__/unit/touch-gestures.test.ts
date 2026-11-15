/**
 * Touch gestures — the mobile upgrade's deterministic core.
 * Swipes, pull-to-refresh and the responsive contracts, pinned without a browser.
 */

import {
  PULL_ARM_DISTANCE,
  SWIPE_MIN_DISTANCE,
  advancePullRefresh,
  classifySwipe,
  composerBottomOffset,
  finishPullRefresh,
  showsBottomNav,
} from "@/lib/client/touch-gestures";

describe("touch gestures — classifySwipe", () => {
  it("detects a dominant horizontal swipe", () => {
    expect(classifySwipe({ x: 200, y: 200 }, { x: 300, y: 205 })).toEqual({ direction: "right", distance: 100 });
    expect(classifySwipe({ x: 300, y: 200 }, { x: 200, y: 205 })).toEqual({ direction: "left", distance: 100 });
  });

  it("detects a dominant vertical swipe", () => {
    expect(classifySwipe({ x: 200, y: 400 }, { x: 205, y: 300 })).toEqual({ direction: "up", distance: 100 });
    expect(classifySwipe({ x: 200, y: 300 }, { x: 205, y: 400 })).toEqual({ direction: "down", distance: 100 });
  });

  it("rejects movements below the minimum distance", () => {
    expect(classifySwipe({ x: 200, y: 200 }, { x: 240, y: 200 })).toBeNull();
    expect(classifySwipe({ x: 200, y: 200 }, { x: 200, y: 200 })).toBeNull();
  });

  it("honours a custom minimum distance", () => {
    expect(classifySwipe({ x: 0, y: 0 }, { x: 60, y: 0 }, 100)).toBeNull();
    expect(classifySwipe({ x: 0, y: 0 }, { x: 120, y: 0 }, 100)).toEqual({ direction: "right", distance: 120 });
  });

  it("rejects ambiguous diagonal gestures (scroll wins)", () => {
    // 45° diagonal — neither axis dominates at 1.5×.
    expect(classifySwipe({ x: 0, y: 0 }, { x: 100, y: 100 })).toBeNull();
  });

  it("tolerates small off-axis drift on a clear swipe", () => {
    expect(classifySwipe({ x: 0, y: 0 }, { x: 100, y: 30 })).toEqual({ direction: "right", distance: 100 });
  });

  it("exposes the default thresholds", () => {
    expect(SWIPE_MIN_DISTANCE).toBeGreaterThan(0);
    expect(PULL_ARM_DISTANCE).toBeGreaterThan(SWIPE_MIN_DISTANCE);
  });
});

describe("touch gestures — pull to refresh", () => {
  it("stays idle while the page is scrolled", () => {
    expect(advancePullRefresh("idle", 120, 200, "move")).toEqual({ state: "idle", progress: 0 });
  });

  it("pulls at the top and arms past the threshold", () => {
    expect(advancePullRefresh("idle", 0, 40, "move")).toEqual({ state: "pulling", progress: 0.5 });
    expect(advancePullRefresh("idle", 0, PULL_ARM_DISTANCE, "move")).toEqual({ state: "armed", progress: 1 });
  });

  it("fires the refresh when an armed pull releases", () => {
    expect(advancePullRefresh("armed", 0, 100, "release")).toEqual({ state: "refreshing", progress: 1 });
  });

  it("resets to idle when an un-armed pull releases", () => {
    expect(advancePullRefresh("pulling", 0, 40, "release")).toEqual({ state: "idle", progress: 0 });
  });

  it("latches refreshing until explicitly finished", () => {
    expect(advancePullRefresh("refreshing", 0, 0, "move")).toEqual({ state: "refreshing", progress: 1 });
    expect(advancePullRefresh("refreshing", 0, 0, "release")).toEqual({ state: "refreshing", progress: 1 });
    expect(finishPullRefresh()).toEqual({ state: "idle", progress: 0 });
  });

  it("clamps the pull indicator at twice the arm distance", () => {
    expect(advancePullRefresh("idle", 0, 10000, "move")).toEqual({ state: "armed", progress: 1 });
  });
});

describe("touch gestures — responsive contracts", () => {
  it("shows the bottom nav only below the sm breakpoint", () => {
    expect(showsBottomNav(390)).toBe(true);
    expect(showsBottomNav(639)).toBe(true);
    expect(showsBottomNav(640)).toBe(false);
    expect(showsBottomNav(1280)).toBe(false);
  });

  it("offsets the composer by the bottom-nav height on mobile", () => {
    expect(composerBottomOffset(390)).toBe(56);
    expect(composerBottomOffset(1024)).toBe(0);
  });
});
