import { Effect, Exit, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryPromiseSettling } from "../src/effectPromise";

/**
 * `tryPromiseSettling` exists because `Effect.tryPromise` ABANDONS its promise on
 * interruption (M8): it aborts the signal it handed the callback and lets the
 * fiber finish interrupting, which releases whatever the promise is still
 * holding — a permit, in the transfer path — while the promise itself keeps
 * running with its buffers reachable.
 *
 * These tests pin the four properties the transfer permit depends on: the happy
 * path is unchanged, an interrupt does not COMPLETE until the abandoned promise
 * settles, the callback still gets an aborted signal so a signal-aware callee
 * settles fast, and the settle wait is bounded so a promise that never settles
 * cannot wedge the permit for the process lifetime.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class Boom {
  readonly _tag = "Boom";
  constructor(readonly cause: unknown) {}
}

describe("tryPromiseSettling — uninterrupted behaviour", () => {
  it("passes a resolved value straight through", async () => {
    const value = await Effect.runPromise(
      tryPromiseSettling({
        try: () => Promise.resolve(7),
        catch: (cause) => new Boom(cause),
      }),
    );

    expect(value).toBe(7);
  });

  it("maps a rejection through `catch`, like Effect.tryPromise", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        tryPromiseSettling({
          try: () => Promise.reject(new Error("kaboom")),
          catch: (cause) => new Boom(cause),
        }),
      ),
    );

    expect(error).toBeInstanceOf(Boom);
    expect((error.cause as Error).message).toBe("kaboom");
  });
});

describe("tryPromiseSettling — interruption", () => {
  it("does not finish interrupting until the abandoned promise settles", async () => {
    const gate = deferred<number>();
    const entered = deferred<void>();
    const order: string[] = [];
    let orderWhileHeld: readonly string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          tryPromiseSettling({
            try: () => {
              entered.resolve();
              return gate.promise.then((value) => {
                order.push("promise settled");
                return value;
              });
            },
            catch: (cause) => new Boom(cause),
            // Bounded well under the 60s default: if this test ever stops
            // releasing the gate it should fail, not wedge the suite.
            settleTimeoutMs: 2_000,
            label: "gated promise",
          }),
        );
        // Deterministic rather than timed: the interrupt below must land on a
        // promise that has actually started.
        yield* Effect.promise(() => entered.promise);

        // Forked, not awaited: post-fix this effect cannot complete until the
        // gate resolves, which is the whole point.
        const interrupting = yield* Effect.fork(
          Fiber.interrupt(fiber).pipe(
            Effect.tap(() => Effect.sync(() => order.push("interrupt finished"))),
          ),
        );
        yield* Effect.sleep("50 millis");
        // Snapshot rather than assert in-fiber: a throw here would be a defect
        // that never releases the gate.
        orderWhileHeld = [...order];

        yield* Effect.sync(() => gate.resolve(1));
        yield* Fiber.join(interrupting).pipe(Effect.timeout("2 seconds"));
      }),
    );

    // 50ms of nothing: the interrupt was still in flight, holding whatever the
    // fiber holds.
    expect(orderWhileHeld).toEqual([]);
    expect(order).toEqual(["promise settled", "interrupt finished"]);
  });

  it("aborts the signal it handed the callback", async () => {
    // A signal-aware callee (both fs sites are) settles as soon as it is
    // aborted, so the settle wait costs nothing there.
    const gate = deferred<number>();
    const entered = deferred<void>();
    let aborted = false;

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          tryPromiseSettling({
            try: (signal) => {
              signal.addEventListener("abort", () => {
                aborted = true;
                gate.resolve(1);
              });
              entered.resolve();
              return gate.promise;
            },
            catch: (cause) => new Boom(cause),
            settleTimeoutMs: 2_000,
          }),
        );
        yield* Effect.promise(() => entered.promise);
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"));
      }),
    );

    expect(aborted).toBe(true);
  });

  it("still exits as an interrupt once the promise settles", async () => {
    const gate = deferred<number>();
    const entered = deferred<void>();

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          tryPromiseSettling({
            try: () => {
              entered.resolve();
              return gate.promise;
            },
            catch: (cause) => new Boom(cause),
            settleTimeoutMs: 2_000,
          }),
        );
        yield* Effect.promise(() => entered.promise);
        const interrupting = yield* Effect.fork(Fiber.interrupt(fiber));
        yield* Effect.sleep("20 millis");
        yield* Effect.sync(() => gate.resolve(42));
        return yield* Fiber.join(interrupting).pipe(Effect.timeout("2 seconds"));
      }),
    );

    // Waiting for the promise must not turn the interrupt into a success — the
    // value is discarded and the fiber is still interrupted.
    expect(Exit.isInterrupted(exit)).toBe(true);
  });

  it("releases after the settle bound expires, and says so on stderr", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A hung key server: no Seal API takes a signal, so nothing can make this
    // settle. Without the bound the permit would be gone for the process life.
    const neverSettles = new Promise<number>(() => {});
    const entered = deferred<void>();
    const startedAt = performance.now();

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          tryPromiseSettling({
            try: () => {
              entered.resolve();
              return neverSettles;
            },
            catch: (cause) => new Boom(cause),
            settleTimeoutMs: 100,
            label: "Seal decrypt",
          }),
        );
        yield* Effect.promise(() => entered.promise);
        return yield* Fiber.interrupt(fiber).pipe(Effect.timeout("3 seconds"));
      }),
    );

    expect(Exit.isInterrupted(exit)).toBe(true);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(logged.mock.calls.flat().join(" ")).toContain(
      "[console-mcp] releasing the transfer permit while a cancelled Seal decrypt is still pending",
    );
  });
});
