// Account plugin — per-address lease helper.
//
// Thin wrapper over `LeaseBrokerService.acquire(...)` that opens a
// fresh scope per call and keys the lease as `account:<address>`.
// Both the funding pass (`funding.ts`) and the resolved-value
// sign/execute closures (`service.ts`) share this helper so the
// per-key encoding lives in exactly one place.
//
// Substrate name-blindness: the broker treats the key as opaque —
// the `account:` prefix is a plugin convention so the broker's
// `holders()` snapshot is readable in the renderer / debug logs.

import { Effect } from 'effect';

import { leaseKey, type LeaseBroker } from '../../substrate/runtime/lease-broker/index.ts';

/** Run `effect` while holding the per-address lease. Scope-bound
 *  release: a fresh scope is opened per call, the broker installs
 *  an uninterruptible finalizer, and the lease drops the moment
 *  the inner Effect returns. Same-address concurrent callers
 *  serialize via the broker's FIFO queue.
 *
 *  Non-reentrant: nested calls for the SAME (broker, accountName,
 *  address) tuple deadlock. The broker has no concept of
 *  re-entrancy by design — per-address sequence-number semantics
 *  require at-most-one in-flight. */
export const withAddressLease = <A, E, R>(
	broker: LeaseBroker,
	accountName: string,
	address: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* broker.acquire(leaseKey(`account:${address}`), accountName);
			return yield* effect;
		}),
	);
