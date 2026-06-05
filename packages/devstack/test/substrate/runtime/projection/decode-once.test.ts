// Regression — `updateRef` previously decoded the
// `projection.updated` payload twice on the happy path: once
// pre-flight (to drive the warning emission for malformed payloads
// inside the fiber's logger Layer) and once again inside the reducer
// (under `SubscriptionRef.update`). This test pins the contract that
// the hot path decodes exactly once per applyEvent.
//
// We can't `vi.spyOn(Schema, 'decodeUnknownSync')` because ES module
// exports are read-only. Instead we observe decode passes by wrapping
// the payload in a Proxy that increments a counter on each property
// access — `Schema.decodeUnknownSync` walks every required field of
// the struct on each pass, so the per-decode access-count delta is
// constant. Two decodes would produce ~2× the field accesses of
// one. We compare against a baseline of "decode the payload once,
// directly" to avoid baking the struct's field count into the
// assertion.

import { Effect, Schema, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';

import { pluginKey } from '../../../../src/substrate/brand.ts';
import { emptyProjection } from '../../../../src/substrate/runtime/projection/state-ref.ts';
import {
	AccountProjectionSchema,
	PackageProjectionSchema,
	updateRef,
} from '../../../../src/substrate/runtime/projection/update.ts';

const countingProxy = <T extends object>(target: T): { proxy: T; getCount: () => number } => {
	let count = 0;
	const proxy = new Proxy(target, {
		get(t, prop, receiver) {
			count += 1;
			return Reflect.get(t, prop, receiver);
		},
	});
	return { proxy, getCount: () => count };
};

const packagePayload = () => ({
	key: 'package/vault',
	rowKey: pluginKey('package/vault#1'),
	name: 'vault',
	kind: 'local' as const,
	packageId: '0x123',
	upgradeCapId: null,
	mvrPlaceholder: '@local/vault',
	sourcePath: 'move/vault',
	updatedAt: 3,
});

const accountPayload = () => ({
	key: 'account/alice',
	rowKey: pluginKey('wallet#0'),
	name: 'alice',
	address: '0xabc',
	scheme: 'ed25519' as const,
	source: 'real' as const,
	funding: {
		status: 'funded' as const,
		balanceMist: '1000',
		requestedMist: '1000',
	},
	walletVisible: true,
	updatedAt: 5,
});

describe('updateRef decode-once contract', () => {
	it('decodes a valid projection.updated[package] payload exactly once', async () => {
		// Baseline — direct decode of the payload through the proxy:
		// records the field-access count of exactly one decode pass.
		const baseline = countingProxy(packagePayload());
		Schema.decodeUnknownSync(PackageProjectionSchema)(baseline.proxy);
		const oneDecodeAccesses = baseline.getCount();
		expect(oneDecodeAccesses).toBeGreaterThan(0);

		// Now run updateRef through the same proxy and compare.
		const observed = countingProxy(packagePayload());
		const ref = await Effect.runPromise(SubscriptionRef.make(emptyProjection()));
		await Effect.runPromise(
			updateRef(ref, {
				tag: 'projection.updated',
				kind: 'package',
				key: 'package/vault',
				payload: observed.proxy,
				at: 3,
			}),
		);
		// One decode pass = one set of field accesses. Two decodes
		// (the pre-fix shape) would double the access count.
		expect(observed.getCount()).toBe(oneDecodeAccesses);

		// Sanity — the projection actually committed.
		const state = SubscriptionRef.getUnsafe(ref);
		expect(state.packages).toHaveLength(1);
		expect(state.packages[0]?.name).toBe('vault');
	});

	it('decodes a valid projection.updated[account] payload exactly once', async () => {
		const baseline = countingProxy(accountPayload());
		Schema.decodeUnknownSync(AccountProjectionSchema)(baseline.proxy);
		const oneDecodeAccesses = baseline.getCount();

		const observed = countingProxy(accountPayload());
		const ref = await Effect.runPromise(SubscriptionRef.make(emptyProjection()));
		await Effect.runPromise(
			updateRef(ref, {
				tag: 'projection.updated',
				kind: 'account',
				key: 'account/alice',
				payload: observed.proxy,
				at: 5,
			}),
		);
		expect(observed.getCount()).toBe(oneDecodeAccesses);
	});

	// Malformed payload — the pre-flight decode fails, the warning
	// emits, and the reducer drops the slice. The malformed path
	// also decodes exactly once: pre-flight failure result is
	// threaded into applyEvent, which short-circuits the slice
	// update without re-decoding.
	it('drops a malformed projection.updated payload and advances lastEvent.at', async () => {
		const ref = await Effect.runPromise(SubscriptionRef.make(emptyProjection()));
		await Effect.runPromise(
			updateRef(ref, {
				tag: 'projection.updated',
				kind: 'package',
				key: 'package/broken',
				// Missing required fields — decode fails.
				payload: { name: 'broken' } as unknown as Readonly<Record<string, unknown>>,
				at: 7,
			}),
		);
		const state = SubscriptionRef.getUnsafe(ref);
		expect(state.packages).toHaveLength(0);
		// `lastEvent.at` advances so renderers see the event was
		// observed — same contract as before.
		expect(state.lastEvent.at).toBe(7);
	});
});
