// Regression — `runStack(...)` allocates the projection ref at
// API-entry time (before any Effect runtime runs) so the caller can
// subscribe to `state.changes` before boot. The explicit
// `makeProjectionRefSync` variant pins that contract at the substrate
// constructor — if a future refactor of `makeProjectionRef` layers an
// async/withSpan/annotation wrapper, this test will catch the
// regression at the sync seam instead of as a boot-time
// `Effect.runSync` crash.

import { Effect, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';

import {
	makeProjectionRef,
	makeProjectionRefSync,
} from '../../../../src/substrate/runtime/projection/state-ref.ts';

describe('makeProjectionRefSync', () => {
	it('returns a usable SubscriptionRef synchronously (no Effect.runSync at the caller)', () => {
		const ref = makeProjectionRefSync();
		expect(SubscriptionRef.isSubscriptionRef(ref)).toBe(true);
		// `SubscriptionRef.getUnsafe` is a sync read of `ref.value`; the
		// ref must be initialised to the empty projection so a caller
		// who reads before boot sees the canonical initial state.
		const initial = SubscriptionRef.getUnsafe(ref);
		expect(initial.cycle.phase).toBe('booting');
		expect(initial.rows).toEqual([]);
		expect(initial.endpoints).toEqual([]);
		expect(initial.lastEvent).toEqual({ seq: 0, at: 0 });
	});

	it('matches the shape produced by the Effect-wrapped makeProjectionRef', async () => {
		// Sanity check that both constructors agree on the initial
		// projection — the sync variant is documented as a thin sync
		// projection of the Effect-wrapped one.
		const syncRef = makeProjectionRefSync();
		const effectRef = await Effect.runPromise(makeProjectionRef());
		expect(SubscriptionRef.getUnsafe(syncRef)).toEqual(SubscriptionRef.getUnsafe(effectRef));
	});
});
