import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  CHECK_IN_DELAY_MS,
  CHECK_IN_TIMEOUT_MS,
  type CheckInDeps,
  checkInWithConsole,
  resetCheckInForTests,
} from "../src/startupCheckIn";

/** The once-only, delayed, fire-and-forget contract of the startup check-in. */

beforeEach(() => {
  resetCheckInForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function deps(
  overrides: { call?: Mock<CheckInDeps["call"]>; log?: Mock<CheckInDeps["log"]> } = {},
) {
  const stdin = new AbortController();
  return {
    call: overrides.call ?? vi.fn<CheckInDeps["call"]>().mockResolvedValue(undefined),
    log: overrides.log ?? vi.fn<CheckInDeps["log"]>(),
    closed: stdin.signal,
    closeStdin: () => stdin.abort(),
  };
}

/** A call that never answers, and rejects once its signal aborts. */
const hangingCall = () =>
  vi.fn<CheckInDeps["call"]>(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );

describe("checkInWithConsole", () => {
  it("makes the call once, however many times it is started", async () => {
    const d = deps();

    checkInWithConsole(d);
    checkInWithConsole(d);
    await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS);

    expect(d.call).toHaveBeenCalledTimes(1);
    expect(d.log).not.toHaveBeenCalled();
  });

  it("returns nothing, so there is nothing for the caller to await", () => {
    expect(checkInWithConsole(deps())).toBeUndefined();
  });

  it("waits out the delay before calling Console", async () => {
    const d = deps();

    checkInWithConsole(d);
    await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS - 1);
    expect(d.call).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(d.call).toHaveBeenCalledTimes(1);
  });

  it("skips the call when stdin ends before the delay, as a health check does", async () => {
    const d = deps();

    checkInWithConsole(d);
    await vi.advanceTimersByTimeAsync(100);
    d.closeStdin();
    await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS);

    expect(d.call).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it("aborts an in-flight call when stdin ends, without logging", async () => {
    const d = deps({ call: hangingCall() });

    checkInWithConsole(d);
    await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS);
    const signal = d.call.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);

    d.closeStdin();
    await vi.advanceTimersByTimeAsync(0);

    expect(signal?.aborted).toBe(true);
    expect(d.log).not.toHaveBeenCalled();
  });

  it("logs one line and does not throw when the call fails", async () => {
    const d = deps({ call: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) });

    expect(() => checkInWithConsole(d)).not.toThrow();
    await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS);

    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log.mock.calls[0]?.[0]).toContain("ECONNREFUSED");
    expect(d.log.mock.calls[0]?.[0]).toContain("ping_console");
  });

  it("aborts a call that never answers and says so", async () => {
    const d = deps({ call: hangingCall() });

    checkInWithConsole(d);
    await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS + CHECK_IN_TIMEOUT_MS);

    expect(d.call.mock.calls[0]?.[0].aborted).toBe(true);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log.mock.calls[0]?.[0]).toContain("no answer within 10 seconds");
  });

  it("survives a logger that throws", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      checkInWithConsole(
        deps({
          call: vi.fn().mockRejectedValue(new Error("boom")),
          log: vi.fn<CheckInDeps["log"]>(() => {
            throw new Error("stderr closed");
          }),
        }),
      );
      await vi.advanceTimersByTimeAsync(CHECK_IN_DELAY_MS);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
