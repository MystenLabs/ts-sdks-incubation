import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { canReuseSessionKey, singleFlight } from "../src/console/SealCryptoService";

/**
 * Unit tests for the SessionKey caching decisions. The full decrypt() path is not
 * exercised here: it would require mocking four SDK surfaces at once
 * (@mysten/seal SessionKey/SealClient/EncryptedObject, @mysten/sui Transaction,
 * and the gRPC client) with no existing mock scaffolding in the repo. The two
 * pieces of decision logic — when a cached key may be reused, and how concurrent
 * cold callers share one creation — are extracted and tested directly.
 */

const ADDR = "0xabc";
const PKG = "0xpackage";
const TTL = 10;
const WANT = { address: ADDR, packageId: PKG, ttlMin: TTL };
const fresh = { ...WANT, sessionKey: { isExpired: () => false } };
const expired = { ...WANT, sessionKey: { isExpired: () => true } };

describe("canReuseSessionKey", () => {
  it("returns false when there is no cached key", () => {
    expect(canReuseSessionKey(undefined, WANT)).toBe(false);
  });

  it("returns true for matching parameters that are not expired", () => {
    expect(canReuseSessionKey(fresh, WANT)).toBe(true);
  });

  it("returns false when the cached key has expired", () => {
    expect(canReuseSessionKey(expired, WANT)).toBe(false);
  });

  it("returns false when the signer address differs", () => {
    expect(canReuseSessionKey(fresh, { ...WANT, address: "0xdifferent" })).toBe(false);
  });

  // A key is bound to the package it was created for, so handing one back to a
  // caller asking about a different package would be a cross-package reuse.
  it("returns false when the package id differs", () => {
    expect(canReuseSessionKey(fresh, { ...WANT, packageId: "0xother" })).toBe(false);
  });

  // A cached 10-minute key does not satisfy a caller that asked for 60.
  it("returns false when the requested ttl differs", () => {
    expect(canReuseSessionKey(fresh, { ...WANT, ttlMin: 60 })).toBe(false);
  });
});

describe("singleFlight", () => {
  /**
   * A cache + an async create, wired exactly as getSessionKey wires them. `create`
   * yields to the event loop before storing, which is what let concurrent callers
   * all miss the cache in the pre-fix code.
   */
  function makeSubject(behavior: "succeed" | "fail" = "succeed") {
    let cached: string | undefined;
    let creates = 0;
    const lock = Effect.runSync(Effect.makeSemaphore(1));
    const create = Effect.gen(function* () {
      creates += 1;
      yield* Effect.sleep("10 millis"); // stands in for the getObject RPC + signature
      if (behavior === "fail") return yield* Effect.fail("boom" as const);
      cached = `session-${creates}`;
      return cached;
    });
    return {
      creates: () => creates,
      get: () => singleFlight(lock, () => cached, create),
      evict: () => {
        cached = undefined;
      },
    };
  }

  // Regression: five parallel download_file calls on a cold cache used to issue
  // five SessionKey.create() round-trips, because each read the empty cache
  // before the first create resolved.
  it("runs create once for many concurrent cold callers", async () => {
    const subject = makeSubject();
    const results = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 5 }, () => subject.get()),
        { concurrency: "unbounded" },
      ),
    );
    expect(subject.creates()).toBe(1);
    expect(results).toEqual(Array.from({ length: 5 }, () => "session-1"));
  });

  it("serves a warm cache without touching the lock", async () => {
    const subject = makeSubject();
    await Effect.runPromise(subject.get());
    await Effect.runPromise(subject.get());
    expect(subject.creates()).toBe(1);
  });

  it("creates again after the cached value is evicted (expiry)", async () => {
    const subject = makeSubject();
    await Effect.runPromise(subject.get());
    subject.evict();
    const second = await Effect.runPromise(subject.get());
    expect(subject.creates()).toBe(2);
    expect(second).toBe("session-2");
  });

  // A failed create must not wedge the lock or leave a stale in-flight entry:
  // the permit is released with the cache still empty, so the next caller retries.
  it("propagates a create failure and lets the next caller retry", async () => {
    const failing = makeSubject("fail");
    const error = await Effect.runPromise(Effect.flip(failing.get()));
    expect(error).toBe("boom");
    await Effect.runPromise(Effect.flip(failing.get()));
    expect(failing.creates()).toBe(2);
  });
});

/**
 * The failure geometry of a single-flighted create against a stalled RPC.
 *
 * Deduping the create is right on the happy path, but it changed what happens
 * when the create never returns: waiters queue on the permit, and each one that
 * reaches the front re-reads the still-empty cache and starts its OWN create. So
 * N cold callers fail at ~T, ~2T … ~NT instead of together at ~T.
 *
 * getSessionKey therefore bounds the WHOLE acquisition — the wait for the lock
 * as well as the create — not just the create. These tests pin that difference,
 * since both placements look equally correct until the create hangs.
 */
describe("singleFlight under a stalled create", () => {
  const TIMEOUT = 60; // ms — stands in for SESSION_KEY_TIMEOUT
  const CALLERS = 5;

  /** A create that never settles, the way a stalled getObject never settles. */
  function hangingSubject() {
    let creates = 0;
    const lock = Effect.runSync(Effect.makeSemaphore(1));
    const create = Effect.gen(function* () {
      creates += 1;
      yield* Effect.never;
      return "unreachable";
    });
    // The cache is permanently empty here, not merely empty at first: the create
    // never completes, so nothing is ever stored. That is what makes each waiter
    // reaching the front of the queue start its own create.
    return { creates: () => creates, get: () => singleFlight(lock, () => undefined, create) };
  }

  it("bounds every caller at one timeout, not one per queue position", async () => {
    const subject = hangingSubject();
    const started = performance.now();

    const outcomes = await Effect.runPromise(
      Effect.all(
        Array.from({ length: CALLERS }, () =>
          // The bound wraps singleFlight itself — lock wait included.
          Effect.flip(
            subject.get().pipe(
              Effect.timeoutFail({
                duration: `${TIMEOUT} millis`,
                onTimeout: () => "gave-up" as const,
              }),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      ),
    );
    const elapsed = performance.now() - started;

    expect(outcomes).toEqual(Array.from({ length: CALLERS }, () => "gave-up"));
    // The point of the test: ~T, not ~5T. Generous ceiling so it cannot flake on
    // a loaded machine while still failing loudly against per-create bounding,
    // which would need at least 5 x 60ms = 300ms.
    expect(elapsed).toBeLessThan(TIMEOUT * 3);
  });

  it("does not leave the lock wedged for a later caller", async () => {
    const subject = hangingSubject();
    await Effect.runPromise(
      Effect.flip(
        subject
          .get()
          .pipe(Effect.timeoutFail({ duration: "20 millis", onTimeout: () => "gave-up" as const })),
      ),
    );
    // An interrupted holder must release its permit, or every later caller
    // inherits the stall instead of getting its own attempt.
    const second = await Effect.runPromise(
      Effect.flip(
        subject
          .get()
          .pipe(Effect.timeoutFail({ duration: "20 millis", onTimeout: () => "gave-up" as const })),
      ),
    );
    expect(second).toBe("gave-up");
    expect(subject.creates()).toBe(2);
  });
});
