// Lease broker — substrate-level service interface.
//
// Architecture (`notes/redesign/architecture.md` § "L0 substrate
// primitives"): the substrate owns a generic lease primitive keyed by
// an opaque resource identifier. Any caller that needs at-most-one-
// in-flight serialization on a resource yields this service and calls
// `acquire(key, owner)`. The first canonical consumer is the per-
// address sequence-number lock (`plugins/account/address-lock.ts`,
// today plugin-local; PR3 lifts it to consume this primitive);
// callers in the same shape — sign+execute pipelines, per-connection
// gate, per-slot work queue — share the same seam.
//
// Substrate name-blindness: the broker has no concept of what a
// `LeaseKey` represents. The plugin author chooses the key shape; the
// broker treats it as an opaque string with a brand. A wallet might
// key by `account:<address>`, a GPU-bound plugin by `gpu:<slot>` —
// the broker doesn't care.
//
// Lifetime: scope-bound. `acquire` returns a `Lease` handle whose
// release fires when the surrounding `Effect.Scope` closes. There is
// no `release()` method on `Lease` — the only release path is the
// scope finalizer, which makes "I forgot to release" structurally
// impossible.
//
// Mechanics: per-key state in a single `Ref<State>`. The blocking
// queue is a FIFO of `Waiter`s carrying a `Deferred` that the
// outgoing holder's finalizer resolves AFTER atomically installing
// the next holder. `tryAcquire` does the same atomic-claim CAS as
// `acquire`'s first step, but skips the wait — returning `null` if
// the key is held.

import { Context, Deferred, Effect, Layer, Ref, Scope } from 'effect';

import type { Brand } from '../../brand.ts';

// ----------------------------------------------------------------------
// Public shape
// ----------------------------------------------------------------------

/** Opaque resource identifier. Substrate-blind: the broker treats
 *  this as a string for map keying and never inspects it. Plugin
 *  authors choose the encoding (`account:<addr>`, `gpu:<slot>`, etc.). */
export type LeaseKey = Brand<string, 'LeaseKey'>;

/** Construct a `LeaseKey` from a free-form string. The boundary at
 *  which unbranded strings become branded; downstream code only sees
 *  branded values. */
export const leaseKey = (s: string): LeaseKey => s as LeaseKey;

/** Free-form owner identity, used for diagnostics (`holders()` output,
 *  span attributes). The broker does NOT use this for re-entrancy:
 *  two `acquire` calls from the same owner against the same key will
 *  deadlock the second call. */
export type Owner = string;

/** Lease handle. Carries only the diagnostic pair; the release is the
 *  scope finalizer, not a method.
 *
 *  Why no `release()`: every consumer we have today wraps the lease
 *  in `Effect.scoped` and lets the scope finalizer fire. Exposing an
 *  explicit `release()` would invite double-release, release-while-
 *  scope-still-open, and the "I released early but forgot to clear
 *  the variable" footgun. The scope IS the lifetime. */
export interface Lease {
	readonly key: LeaseKey;
	readonly owner: Owner;
}

/** Service shape — what plugins yield from Context. */
export interface LeaseBroker {
	/**
	 * Acquire the lease for `key`, attributed to `owner`. Blocks if the
	 * lease is already held, waiting in FIFO order behind earlier
	 * waiters. Cancellable: an interrupt while waiting unwinds without
	 * acquiring.
	 *
	 * Scope-bound release: the broker installs an uninterruptible
	 * finalizer on the surrounding scope. Calling `Effect.scoped` over
	 * an `acquire(...)` is the canonical shape.
	 *
	 * Non-reentrant: `acquire` from the same owner against a key the
	 * owner already holds will deadlock. Per-address sequence-number
	 * semantics require at-most-one in-flight; nesting is the caller's
	 * bug.
	 */
	readonly acquire: (key: LeaseKey, owner: Owner) => Effect.Effect<Lease, never, Scope.Scope>;

	/**
	 * Non-blocking variant. Returns `null` if the lease is held by any
	 * owner (including the calling owner); otherwise atomically claims
	 * the lease and returns the handle. The atomic-claim CAS is the
	 * same as `acquire`'s first step — the only difference is the
	 * `null` return vs. enqueue.
	 *
	 * Scope-bound release: same finalizer install as `acquire` when
	 * the claim wins.
	 */
	readonly tryAcquire: (
		key: LeaseKey,
		owner: Owner,
	) => Effect.Effect<Lease | null, never, Scope.Scope>;

	/**
	 * Snapshot of current holders, keyed by `LeaseKey`. For diagnostics
	 * (renderer, debug logs); the result is a point-in-time read and
	 * may be stale by the time it's inspected.
	 */
	readonly holders: () => Effect.Effect<ReadonlyMap<LeaseKey, Owner>>;
}

// ----------------------------------------------------------------------
// Internal state
// ----------------------------------------------------------------------

/** A fiber parked on `Deferred.await` waiting to become the next
 *  holder. The outgoing holder's finalizer transfers ownership by
 *  setting `holder = waiter.owner` on the per-key entry AND resolving
 *  the deferred — the awoken waiter doesn't re-CAS.
 *
 *  `Waiter` reference identity is the cancellation key: an interrupted
 *  waiter removes itself by reference-equality. */
interface Waiter {
	readonly owner: Owner;
	readonly signal: Deferred.Deferred<void>;
}

interface KeyEntry {
	readonly holder: Owner;
	readonly waiters: ReadonlyArray<Waiter>;
}

type State = ReadonlyMap<LeaseKey, KeyEntry>;

// ----------------------------------------------------------------------
// Service tag + Layer
// ----------------------------------------------------------------------

export class LeaseBrokerService extends Context.Service<LeaseBrokerService, LeaseBroker>()(
	'@devstack-rewrite/substrate/LeaseBroker',
) {}

/**
 * In-process Layer. One broker per stack scope; closing the layer's
 * scope drops every entry. Parallel stacks each get their own broker
 * — the broker is name-blind, so cross-stack coordination on the
 * same logical key (e.g. an address that two stacks share) is NOT
 * provided here. A cross-process layer can be slotted in later as a
 * sibling factory; today's consumers are in-process only.
 */
export const layerLeaseBroker: Layer.Layer<LeaseBrokerService> = Layer.effect(
	LeaseBrokerService,
	Effect.gen(function* () {
		const state = yield* Ref.make<State>(new Map());

		/** Atomic finalizer body: clear `key`'s holder slot and, if any
		 *  waiter is queued, promote the head waiter to holder. Returns
		 *  the promoted waiter (so the caller can resolve their signal)
		 *  or `null` when the key is fully released. Uninterruptible by
		 *  construction — invoked from inside `Effect.addFinalizer` which
		 *  the runtime wraps uninterruptibly. */
		const releaseAndPromote = (key: LeaseKey): Effect.Effect<Waiter | null> =>
			Ref.modify<State, Waiter | null>(state, (current) => {
				const entry = current.get(key);
				if (!entry) return [null, current];
				const head = entry.waiters[0];
				if (head === undefined) {
					const next = new Map(current);
					next.delete(key);
					return [null, next];
				}
				const rest = entry.waiters.slice(1);
				const next = new Map(current);
				next.set(key, { holder: head.owner, waiters: rest });
				return [head, next];
			});

		/** Remove `waiter` from `key`'s waiter list. Called when an
		 *  enqueued waiter is interrupted while parked on its signal. */
		const removeWaiterIfQueued = (key: LeaseKey, waiter: Waiter): Effect.Effect<void> =>
			Ref.update(state, (current) => {
				const entry = current.get(key);
				if (!entry) return current;
				const filtered = entry.waiters.filter((w) => w !== waiter);
				if (filtered.length === entry.waiters.length) return current;
				const next = new Map(current);
				next.set(key, { holder: entry.holder, waiters: filtered });
				return next;
			});

		/** Cleanup on cancellation of a waiting `acquire`: if we were
		 *  still queued, drop ourselves; if we were already promoted to
		 *  holder by a release that raced with our interrupt, release on
		 *  our behalf so the lease doesn't leak. */
		const cleanupCancelledWait = (key: LeaseKey, waiter: Waiter): Effect.Effect<void> =>
			Effect.gen(function* () {
				const becameHolder = yield* Ref.modify<State, boolean>(state, (current) => {
					const entry = current.get(key);
					if (!entry) return [false, current];
					if (entry.holder === waiter.owner && entry.waiters.indexOf(waiter) === -1) {
						// Promoted-but-not-awaited: we were handed the lease
						// in releaseAndPromote but interrupted before the
						// `Deferred.await` returned. Take responsibility for
						// releasing it.
						return [true, current];
					}
					return [false, current];
				});
				if (becameHolder) {
					const promoted = yield* releaseAndPromote(key);
					if (promoted !== null) {
						yield* Deferred.succeed(promoted.signal, undefined);
					}
				} else {
					yield* removeWaiterIfQueued(key, waiter);
				}
			});

		/** Install the scope-bound release finalizer. Uninterruptible —
		 *  losing the release on a Ctrl-C double-tap would leak the
		 *  lease and stall everything queued behind it. */
		const installReleaseFinalizer = (key: LeaseKey): Effect.Effect<void, never, Scope.Scope> =>
			Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const promoted = yield* releaseAndPromote(key);
					if (promoted !== null) {
						yield* Deferred.succeed(promoted.signal, undefined);
					}
				}).pipe(Effect.uninterruptible),
			);

		const acquire: LeaseBroker['acquire'] = (key, owner) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const signal = yield* Deferred.make<void>();
					const waiter: Waiter = { owner, signal };

					const becameHolder = yield* Ref.modify<State, boolean>(state, (current) => {
						const entry = current.get(key);
						if (!entry) {
							const next = new Map(current);
							next.set(key, { holder: owner, waiters: [] });
							return [true, next];
						}
						const next = new Map(current);
						next.set(key, {
							holder: entry.holder,
							waiters: [...entry.waiters, waiter],
						});
						return [false, next];
					});

					if (!becameHolder) {
						yield* restore(Deferred.await(signal)).pipe(
							Effect.onInterrupt(() =>
								cleanupCancelledWait(key, waiter).pipe(Effect.uninterruptible),
							),
						);
					}

					yield* installReleaseFinalizer(key);
					yield* Effect.annotateCurrentSpan({
						'leaseBroker.key': key,
						'leaseBroker.owner': owner,
						'leaseBroker.contended': !becameHolder,
					});
					return { key, owner } satisfies Lease;
				}),
			).pipe(Effect.withSpan('substrate.leaseBroker.acquire'));

		const tryAcquire: LeaseBroker['tryAcquire'] = (key, owner) =>
			Effect.gen(function* () {
				const claimed = yield* Ref.modify<State, boolean>(state, (current) => {
					if (current.has(key)) return [false, current];
					const next = new Map(current);
					next.set(key, { holder: owner, waiters: [] });
					return [true, next];
				});
				if (!claimed) {
					yield* Effect.annotateCurrentSpan({
						'leaseBroker.key': key,
						'leaseBroker.owner': owner,
						'leaseBroker.claimed': false,
					});
					return null;
				}
				yield* installReleaseFinalizer(key);
				yield* Effect.annotateCurrentSpan({
					'leaseBroker.key': key,
					'leaseBroker.owner': owner,
					'leaseBroker.claimed': true,
				});
				return { key, owner } satisfies Lease;
			}).pipe(
				// Make the claim-and-install-finalizer pair atomic w.r.t.
				// interruption: an interrupt arriving AFTER `Ref.modify`
				// claims the slot but BEFORE the finalizer is wired would
				// leak the lease. `Ref.modify` itself is a pure-data
				// transition, so wrapping the whole pipeline uninterruptibly
				// is safe.
				Effect.uninterruptible,
				Effect.withSpan('substrate.leaseBroker.tryAcquire'),
			);

		const holders: LeaseBroker['holders'] = () =>
			Effect.gen(function* () {
				const current = yield* Ref.get(state);
				const out = new Map<LeaseKey, Owner>();
				for (const [k, entry] of current) out.set(k, entry.holder);
				return out;
			});

		return LeaseBrokerService.of({ acquire, tryAcquire, holders });
	}),
);
