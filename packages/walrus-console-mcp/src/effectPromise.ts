import { Effect } from "effect";

/**
 * `Effect.tryPromise`, except that interrupting the fiber does not COMPLETE
 * until the promise it abandoned has actually settled.
 *
 * Why this exists (M8). `Effect.tryPromise` aborts the AbortSignal it handed the
 * callback and then abandons the promise: the fiber finishes interrupting
 * immediately, whatever the promise is still doing. That is fine for a callee
 * that honours the signal, and wrong for one that cannot — no Seal 1.3.x API
 * takes a signal, so a cancelled `sealClient.encrypt`/`decrypt` keeps running
 * with the plaintext AND the ciphertext reachable. Because
 * `ConsoleStorageService`'s size-1 transfer permit is released during that same
 * teardown, the retry an agent issues right after a cancel starts its own
 * payload phase alongside the abandoned one, and peak memory quietly exceeds the
 * `1 x 2 x cap` the permit is supposed to guarantee.
 *
 * The fix is ordering, not cancellation: `Effect.onInterrupt` cleanup runs in
 * the uninterruptible region of the fiber's exit, BEFORE `Semaphore.withPermits`
 * releases via its own `ensuring`. Waiting for the promise inside that cleanup
 * therefore holds the permit until the abandoned work is genuinely done. The
 * price is cancellation latency, not correctness — the caller has already gone
 * away.
 *
 * The wait must be bounded, or this would trade a memory bug for a deadlock: a
 * promise that never settles (a hung Seal key server) would wedge the single
 * permit for the process lifetime. `SealClient`'s own `timeout` is the first
 * layer; `settleTimeoutMs` here is the backstop, after which the permit is
 * released with a line on stderr rather than lost for good.
 */

/** Backstop for a promise that never settles. See the module comment. */
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;

export interface TryPromiseSettlingOptions<A, E> {
  /** The promise to run. Receives the fiber's AbortSignal, as `Effect.tryPromise` does. */
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  /** Maps a rejection to a typed error, exactly as `Effect.tryPromise`'s does. */
  readonly catch: (error: unknown) => E;
  /**
   * How long an interrupt waits for the abandoned promise before giving up on
   * it and releasing anyway. Defaults to 60s.
   */
  readonly settleTimeoutMs?: number;
  /** Named in the give-up log line, so the stderr says which call is still out. */
  readonly label?: string;
}

export function tryPromiseSettling<A, E>(
  options: TryPromiseSettlingOptions<A, E>,
): Effect.Effect<A, E> {
  // `Effect.suspend` gives every RUN of this effect its own slot. An Effect
  // value is a description and may be run more than once (a retry, or two
  // concurrent transfers built from one effect); a slot shared across runs would
  // let one run's interrupt cleanup wait on another run's promise.
  return Effect.suspend(() => {
    let settled: Promise<void> | undefined;

    return Effect.tryPromise({
      // Exactly one declared parameter, deliberately: `Effect.tryPromise` only
      // creates and passes an AbortSignal when the callback takes one
      // (`length === 1`), and aborting it is what lets a signal-aware callee —
      // both `fs` sites — settle immediately instead of running to completion.
      try: (signal) => {
        const running = Promise.resolve(options.try(signal));
        // A separate handle rather than `running` itself: the cleanup only needs
        // to know WHEN it is over, and must not resurface a rejection that the
        // interrupted fiber is no longer there to receive.
        settled = running.then(ignore, ignore);
        return running;
      },
      catch: options.catch,
    }).pipe(
      Effect.onInterrupt(() => {
        // Copied to a const so the narrowing survives into the closure below.
        // Undefined when the fiber was interrupted before the promise started
        // (queued on the permit, say) — nothing is in flight, so nothing to wait for.
        const pending = settled;
        if (pending === undefined) return Effect.void;
        return Effect.promise(() =>
          settleWithin(
            pending,
            options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
            options.label ?? "operation",
          ),
        );
      }),
    );
  });
}

/**
 * Resolve when `settled` does, or when `timeoutMs` elapses — whichever is first.
 *
 * `Promise.race` rather than `Effect.timeout`: this runs inside an
 * uninterruptible interrupt cleanup, and `Effect.timeout` forks a fiber and
 * interrupts the loser, which is the wrong tool there.
 */
function settleWithin(settled: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const bound = setTimeout(() => {
      console.error(
        `[console-mcp] releasing the transfer permit while a cancelled ${label} is still pending`,
      );
      resolve();
    }, timeoutMs);

    // Cleared rather than `unref`ed: an unref'd timer would let an otherwise
    // idle process exit before the bound is even reached, and clearing it on the
    // normal path is what keeps a settled promise from holding the event loop
    // open for the rest of the window.
    void settled.then(() => {
      clearTimeout(bound);
      resolve();
    });
  });
}

function ignore(): void {}
