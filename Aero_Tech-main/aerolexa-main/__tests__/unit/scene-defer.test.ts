/** @jest-environment jsdom */
import { whenIdle } from "@/lib/scene/defer";

/**
 * Idle-deferral contract (S4.2): the hero canvas mounts only after first
 * paint + idle, so the callback is scheduled with requestIdleCallback where
 * it exists (capped by `timeout` so a busy thread can't starve it), with a
 * short setTimeout fallback elsewhere. Scheduling is always cancellable.
 */

describe("whenIdle — idle-deferral contract", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses requestIdleCallback with a timeout cap when available", () => {
    const ric = jest.fn(() => 42);
    const cic = jest.fn();
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = ric;
    (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = cic;

    const cancel = whenIdle(() => undefined, 600);

    expect(ric).toHaveBeenCalledTimes(1);
    expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 600 });

    cancel();
    expect(cic).toHaveBeenCalledWith(42);
  });

  it("falls back to a short setTimeout after first paint", () => {
    jest.useFakeTimers();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;

    const cb = jest.fn();
    whenIdle(cb, 600);

    // One frame's worth of waiting is not enough (the point: first paint wins).
    jest.advanceTimersByTime(150);
    expect(cb).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("the fallback honours a tighter custom timeout", () => {
    jest.useFakeTimers();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;

    const cb = jest.fn();
    whenIdle(cb, 120);

    jest.advanceTimersByTime(119);
    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the fallback from ever firing", () => {
    jest.useFakeTimers();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;

    const cb = jest.fn();
    const cancel = whenIdle(cb, 200);
    cancel();

    jest.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });
});
