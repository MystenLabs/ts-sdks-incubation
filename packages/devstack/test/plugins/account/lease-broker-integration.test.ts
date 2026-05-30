// Account plugin — LeaseBroker integration.
//
// The plugin formerly carried a local `address-lock.ts` per-key
// semaphore registry. That has been lifted to the substrate's
// `LeaseBrokerService`. These tests pin the migration's three
// load-bearing invariants against the real broker layer:
//
//   1. Same-address concurrent sign calls SERIALIZE — the second
//      call waits until the first call's per-call lease scope
//      closes, never interleaves.
//   2. Distinct-address concurrent sign calls run in PARALLEL —
//      different lease keys do not coordinate.
//   3. The lease is SCOPE-BOUND — once a sign call returns, its
//      lease is released, so the broker's holders snapshot drops
//      the entry and a subsequent call for the same address
//      proceeds immediately.
//
// We exercise the migration via the `signer` variant: a stub
// signer whose `signTransaction` awaits a test-controlled Promise
// lets us observe lease ordering without a chain.

import { Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	LeaseBrokerService,
	layerLeaseBroker,
	leaseKey,
} from '../../../src/substrate/runtime/lease-broker/index.ts';
import { layerStrategyRegistry } from '../../../src/substrate/runtime/strategy-registry/index.ts';
import { chainId } from '../../../src/substrate/brand.ts';
import {
	acquireAccount,
	type AccountAcquireContext,
	type ResolvedAccountOptions,
	type AccountValue,
} from '../../../src/plugins/account/service.ts';
import type { SuiSdkShim } from '../../../src/plugins/sui/chain-probe.ts';

// ----------------------------------------------------------------------
// Plain-Promise gate — lets the test runtime release a signer body
// without nesting `Effect.runPromise` inside async stubs.
// ----------------------------------------------------------------------

interface Gate {
	readonly wait: Promise<void>;
	readonly release: () => void;
}

const makeGate = (): Gate => {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
};

// ----------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------

interface StubSigner {
	readonly toSuiAddress: () => string;
	readonly getKeyScheme: () => string;
	readonly getPublicKey: () => { readonly toRawBytes: () => Uint8Array };
	readonly signTransaction: (
		tx: Uint8Array,
	) => Promise<{ readonly bytes: string; readonly signature: string }>;
	readonly signPersonalMessage: (
		msg: Uint8Array,
	) => Promise<{ readonly bytes: string; readonly signature: string }>;
}

/** Stub signer for a fixed address. `signTransaction` awaits a
 *  caller-supplied gate so the test can observe lease ordering. */
const makeStubSigner = (
	address: string,
	gate: Gate,
	calls: Array<{ readonly address: string; readonly tag: string }>,
	tag: string,
): StubSigner => ({
	toSuiAddress: () => address,
	getKeyScheme: () => 'ed25519',
	getPublicKey: () => ({ toRawBytes: () => new Uint8Array(32) }),
	signTransaction: async () => {
		calls.push({ address, tag: `${tag}:enter` });
		await gate.wait;
		calls.push({ address, tag: `${tag}:exit` });
		return { bytes: 'b64-tx', signature: `sig:${tag}` };
	},
	signPersonalMessage: async () => ({
		bytes: 'b64-msg',
		signature: `sig:${tag}`,
	}),
});

/** Minimal SuiSdkShim — the signer variant + no funding path doesn't
 *  consult it; method bodies throw so any accidental read surfaces. */
const stubSuiSdk = (): SuiSdkShim => ({
	core: {
		getObject: () => Promise.reject(new Error('stub getObject')),
		getTransaction: () => Promise.reject(new Error('stub getTransaction')),
		getBalance: () => Promise.reject(new Error('stub getBalance')),
		listCoins: () => Promise.reject(new Error('stub listCoins')),
		executeTransaction: () => Promise.reject(new Error('stub executeTransaction')),
		waitForTransaction: () => Promise.reject(new Error('stub waitForTransaction')),
	},
	client: null as never,
});

const ctx: AccountAcquireContext = {
	sui: { mode: 'local', chain: chainId('sui:localnet'), sdk: stubSuiSdk() },
	runtimeRoot: '/tmp/devstack-rewrite-test',
	app: 'test-app',
	stack: 'test-stack',
	emitAutoPromotionEvent: () => Effect.void,
};

const makeOpts = (name: string, signer: StubSigner): ResolvedAccountOptions => ({
	kind: 'signer',
	name,
	signer,
	addressOverride: signer.toSuiAddress(),
});

/** Acquire an account against the real broker + strategy-registry
 *  layers. The signer variant + no `funding` field means neither
 *  faucet strategy nor SDK calls fire — the closures we exercise
 *  are pure-lease + stub-signer. */
const acquire = (
	name: string,
	signer: StubSigner,
): Effect.Effect<AccountValue, never, LeaseBrokerService> =>
	Effect.gen(function* () {
		const value = yield* acquireAccount(makeOpts(name, signer), ctx).pipe(
			Effect.provide(layerStrategyRegistry),
			Effect.orDie,
		);
		return value;
	});

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

describe('account plugin — LeaseBrokerService integration', () => {
	it.effect('concurrent same-address signTransaction calls serialize via the broker', () =>
		Effect.gen(function* () {
			const address = '0xabc';
			const calls: Array<{ readonly address: string; readonly tag: string }> = [];

			// Two test-controlled gates: each sign call waits on its
			// own gate before returning. We release them in order;
			// if the broker were not serializing, both calls would
			// enter and both would observe the release of their own
			// gate. Serialization means call #2 cannot ENTER until
			// call #1 returns.
			const gate1 = makeGate();
			const gate2 = makeGate();

			const signer = makeStubSigner(address, gate1, calls, 'first');
			// Signer #2 reuses the same address (per-address
			// serialization is keyed on `account:<address>`).
			const signer2: StubSigner = {
				...signer,
				signTransaction: async () => {
					calls.push({ address, tag: 'second:enter' });
					await gate2.wait;
					calls.push({ address, tag: 'second:exit' });
					return { bytes: 'b64-tx', signature: 'sig:second' };
				},
			};

			const a1 = yield* acquire('alice', signer);
			const a2 = yield* acquire('alice2', signer2);

			const fiber1 = yield* Effect.forkChild(a1.signTransaction(new Uint8Array([1])));
			// Yield several times so fiber1's lease-acquire CAS lands
			// and its `tryPromise` parks on gate1 before fiber2
			// enqueues. Without TestClock this is the most direct
			// way to pin enqueue order.
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			const fiber2 = yield* Effect.forkChild(a2.signTransaction(new Uint8Array([2])));
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			// At this point fiber1 is parked on gate1 INSIDE the
			// lease; fiber2 is parked on the broker's per-key signal
			// awaiting fiber1's lease release.
			expect(calls).toEqual([{ address, tag: 'first:enter' }]);

			// Release fiber1's signer gate — fiber1 returns, its
			// lease scope closes, the broker promotes fiber2 to
			// holder, fiber2 enters its signer body.
			gate1.release();
			yield* Fiber.join(fiber1);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			expect(calls).toEqual([
				{ address, tag: 'first:enter' },
				{ address, tag: 'first:exit' },
				{ address, tag: 'second:enter' },
			]);

			gate2.release();
			yield* Fiber.join(fiber2);

			expect(calls).toEqual([
				{ address, tag: 'first:enter' },
				{ address, tag: 'first:exit' },
				{ address, tag: 'second:enter' },
				{ address, tag: 'second:exit' },
			]);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('withTransactionSigner serializes build/sign/execute work for the address', () =>
		Effect.gen(function* () {
			const address = '0xdef';
			const calls: Array<{ readonly address: string; readonly tag: string }> = [];
			const openGate: Gate = { wait: Promise.resolve(), release: () => {} };
			const bodyGate1 = makeGate();
			const bodyGate2 = makeGate();

			const signer1 = makeStubSigner(address, openGate, calls, 'first-sign');
			const signer2 = makeStubSigner(address, openGate, calls, 'second-sign');
			const a1 = yield* acquire('publisher_a', signer1);
			const a2 = yield* acquire('publisher_b', signer2);

			const fiber1 = yield* Effect.forkChild(
				a1.withTransactionSigner((locked) =>
					Effect.gen(function* () {
						calls.push({ address, tag: 'first:build' });
						yield* Effect.promise(() => bodyGate1.wait);
						yield* locked.signTransaction(new Uint8Array([1]));
						calls.push({ address, tag: 'first:execute' });
					}),
				),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			const fiber2 = yield* Effect.forkChild(
				a2.withTransactionSigner((locked) =>
					Effect.gen(function* () {
						calls.push({ address, tag: 'second:build' });
						yield* Effect.promise(() => bodyGate2.wait);
						yield* locked.signTransaction(new Uint8Array([2]));
						calls.push({ address, tag: 'second:execute' });
					}),
				),
			);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			expect(calls).toEqual([{ address, tag: 'first:build' }]);

			bodyGate1.release();
			yield* Fiber.join(fiber1);
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			expect(calls).toEqual([
				{ address, tag: 'first:build' },
				{ address, tag: 'first-sign:enter' },
				{ address, tag: 'first-sign:exit' },
				{ address, tag: 'first:execute' },
				{ address, tag: 'second:build' },
			]);

			bodyGate2.release();
			yield* Fiber.join(fiber2);
			expect(calls).toEqual([
				{ address, tag: 'first:build' },
				{ address, tag: 'first-sign:enter' },
				{ address, tag: 'first-sign:exit' },
				{ address, tag: 'first:execute' },
				{ address, tag: 'second:build' },
				{ address, tag: 'second-sign:enter' },
				{ address, tag: 'second-sign:exit' },
				{ address, tag: 'second:execute' },
			]);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('signAndExecute waits for a failed transaction digest before releasing the lease', () =>
		Effect.gen(function* () {
			const address = '0xfaded';
			const waitGate = makeGate();
			const openGate: Gate = { wait: Promise.resolve(), release: () => {} };
			const signer = makeStubSigner(address, openGate, [], 'failed');
			const waitCtx: AccountAcquireContext = {
				...ctx,
				sui: {
					...ctx.sui,
					sdk: {
						core: {
							getObject: () => Promise.reject(new Error('stub getObject')),
							getTransaction: () => Promise.reject(new Error('stub getTransaction')),
							getBalance: () => Promise.reject(new Error('stub getBalance')),
							listCoins: () => Promise.reject(new Error('stub listCoins')),
							executeTransaction: () =>
								Promise.resolve({
									$kind: 'FailedTransaction',
									FailedTransaction: {
										digest: 'failed-digest',
										status: { error: 'MoveAbort' },
									},
								}),
							waitForTransaction: async () => {
								await waitGate.wait;
							},
						},
						client: null as never,
					},
				},
			};
			const acct = yield* acquireAccount(makeOpts('eve', signer), waitCtx).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);
			const broker = yield* LeaseBrokerService;

			const fiber = yield* Effect.forkChild(Effect.exit(acct.signAndExecute(new Uint8Array([1]))));
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			const heldWhileWaiting = yield* broker.holders();
			expect(heldWhileWaiting.get(leaseKey(`account:${address}`))).toBe('eve');

			waitGate.release();
			const exit = yield* Fiber.join(fiber);
			// On-chain failures are a SUCCESS variant (SDK-shaped union),
			// NOT an error — only transport / sign / wait failures live in
			// the error channel.
			expect(Exit.isSuccess(exit)).toBe(true);
			if (Exit.isSuccess(exit)) {
				expect(exit.value.$kind).toBe('FailedTransaction');
				if (exit.value.$kind === 'FailedTransaction') {
					expect(exit.value.FailedTransaction.digest).toBe('failed-digest');
					expect(exit.value.FailedTransaction.executionError).toContain('MoveAbort');
				}
			}

			const afterWait = yield* broker.holders();
			expect(afterWait.has(leaseKey(`account:${address}`))).toBe(false);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('signAndExecute maps malformed execute envelopes onto AccountSignError', () =>
		Effect.gen(function* () {
			const address = '0xmalformed';
			const signer = makeStubSigner(
				address,
				{ wait: Promise.resolve(), release: () => {} },
				[],
				'malformed',
			);
			const malformedCtx: AccountAcquireContext = {
				...ctx,
				sui: {
					...ctx.sui,
					sdk: {
						core: {
							getObject: () => Promise.reject(new Error('stub getObject')),
							getTransaction: () => Promise.reject(new Error('stub getTransaction')),
							getBalance: () => Promise.reject(new Error('stub getBalance')),
							listCoins: () => Promise.reject(new Error('stub listCoins')),
							executeTransaction: () =>
								Promise.resolve({
									$kind: 'Transaction',
									Transaction: {},
								}),
							waitForTransaction: () => Promise.reject(new Error('should not wait without digest')),
						},
						client: null as never,
					},
				},
			};
			const acct = yield* acquireAccount(makeOpts('mal', signer), malformedCtx).pipe(
				Effect.provide(layerStrategyRegistry),
				Effect.orDie,
			);

			const err = yield* acct.signAndExecute(new Uint8Array([1])).pipe(Effect.flip);
			expect(err._tag).toBe('AccountSignError');
			expect(err.phase).toBe('no-digest');
			expect(err.message).toContain('malformed envelope');
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect(
		'signAndExecute fails with AccountSignError(no-digest) when SDK returns a FailedTransaction without a digest',
		() =>
			Effect.gen(function* () {
				const address = '0xfailednodigest';
				const signer = makeStubSigner(
					address,
					{ wait: Promise.resolve(), release: () => {} },
					[],
					'fail-no-digest',
				);
				const failedNoDigestCtx: AccountAcquireContext = {
					...ctx,
					sui: {
						...ctx.sui,
						sdk: {
							core: {
								getObject: () => Promise.reject(new Error('stub getObject')),
								getTransaction: () => Promise.reject(new Error('stub getTransaction')),
								getBalance: () => Promise.reject(new Error('stub getBalance')),
								listCoins: () => Promise.reject(new Error('stub listCoins')),
								executeTransaction: () =>
									Promise.resolve({
										$kind: 'FailedTransaction',
										FailedTransaction: { status: { error: 'MoveAbort' } },
									}),
								waitForTransaction: () =>
									Promise.reject(new Error('should not wait without digest')),
							},
							client: null as never,
						},
					},
				};
				const acct = yield* acquireAccount(makeOpts('failnd', signer), failedNoDigestCtx).pipe(
					Effect.provide(layerStrategyRegistry),
					Effect.orDie,
				);

				const err = yield* acct.signAndExecute(new Uint8Array([1])).pipe(Effect.flip);
				expect(err._tag).toBe('AccountSignError');
				// Protocol violation, NOT a transport failure (§2 — phases
				// describe steps, not failure kinds).
				expect(err.phase).toBe('no-digest');
				expect(err.message).toContain('FailedTransaction');
			}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect(
		'signAndExecute happy-failed path: FailedTransaction projection carries no sentinel placeholders',
		() =>
			Effect.gen(function* () {
				const address = '0xhappyfailed';
				const signer = makeStubSigner(
					address,
					{ wait: Promise.resolve(), release: () => {} },
					[],
					'happy-failed',
				);
				const happyFailedCtx: AccountAcquireContext = {
					...ctx,
					sui: {
						...ctx.sui,
						sdk: {
							core: {
								getObject: () => Promise.reject(new Error('stub getObject')),
								getTransaction: () => Promise.reject(new Error('stub getTransaction')),
								getBalance: () => Promise.reject(new Error('stub getBalance')),
								listCoins: () => Promise.reject(new Error('stub listCoins')),
								executeTransaction: () =>
									// Digest present, status.error absent — exercises the
									// "no validator error" branch. Per §5 the projection
									// must OMIT `executionError` rather than synthesize a
									// `'<no error>'` sentinel.
									Promise.resolve({
										$kind: 'FailedTransaction',
										FailedTransaction: { digest: 'happy-failed-digest' },
									}),
								waitForTransaction: async () => {},
							},
							client: null as never,
						},
					},
				};
				const acct = yield* acquireAccount(makeOpts('hf', signer), happyFailedCtx).pipe(
					Effect.provide(layerStrategyRegistry),
					Effect.orDie,
				);

				const exit = yield* Effect.exit(acct.signAndExecute(new Uint8Array([1])));
				expect(Exit.isSuccess(exit)).toBe(true);
				if (Exit.isSuccess(exit)) {
					expect(exit.value.$kind).toBe('FailedTransaction');
					if (exit.value.$kind === 'FailedTransaction') {
						const failed = exit.value.FailedTransaction;
						expect(failed.digest).toBe('happy-failed-digest');
						// §5: no sentinel literals at resolved-value surfaces.
						expect(failed.digest).not.toBe('<unknown>');
						expect(failed.executionError).not.toBe('<no error>');
						// Missing-error must be `undefined` (omitted), not a
						// synthesized placeholder string.
						expect(failed.executionError).toBeUndefined();
					}
				}
			}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('distinct-address signTransaction calls run in parallel (no false serialization)', () =>
		Effect.gen(function* () {
			const callsA: Array<{ readonly address: string; readonly tag: string }> = [];
			const callsB: Array<{ readonly address: string; readonly tag: string }> = [];

			const gateA = makeGate();
			const gateB = makeGate();

			const signerA = makeStubSigner('0xaaa', gateA, callsA, 'A');
			const signerB = makeStubSigner('0xbbb', gateB, callsB, 'B');

			const acctA = yield* acquire('alice', signerA);
			const acctB = yield* acquire('bob', signerB);

			const fiberA = yield* Effect.forkChild(acctA.signTransaction(new Uint8Array([1])));
			const fiberB = yield* Effect.forkChild(acctB.signTransaction(new Uint8Array([2])));
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;

			// Both have entered their signer bodies — distinct lease
			// keys do not coordinate.
			expect(callsA).toEqual([{ address: '0xaaa', tag: 'A:enter' }]);
			expect(callsB).toEqual([{ address: '0xbbb', tag: 'B:enter' }]);

			// Release B FIRST — A is still parked on its own gate.
			// If the broker were serializing across keys, B would
			// not have been able to enter at all.
			gateB.release();
			yield* Fiber.join(fiberB);
			expect(callsB).toEqual([
				{ address: '0xbbb', tag: 'B:enter' },
				{ address: '0xbbb', tag: 'B:exit' },
			]);

			gateA.release();
			yield* Fiber.join(fiberA);
			expect(callsA).toEqual([
				{ address: '0xaaa', tag: 'A:enter' },
				{ address: '0xaaa', tag: 'A:exit' },
			]);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect('lease is scope-bound: a sign call releases its lease before returning', () =>
		Effect.gen(function* () {
			const address = '0xccc';
			const calls: Array<{ readonly address: string; readonly tag: string }> = [];

			// Already-resolved gate — the signer body never parks.
			const openGate: Gate = { wait: Promise.resolve(), release: () => {} };
			const signer = makeStubSigner(address, openGate, calls, 'once');
			const acct = yield* acquire('carol', signer);

			yield* acct.signTransaction(new Uint8Array([0]));

			// After the closure returns, the broker should hold NO
			// lease for this key — the per-call scope closed in the
			// `Effect.scoped` wrapper.
			const broker = yield* LeaseBrokerService;
			const snapshot = yield* broker.holders();
			expect(snapshot.has(leaseKey(`account:${address}`))).toBe(false);

			// A second call on the same address proceeds immediately
			// (no waiter parked behind a leaked lease).
			yield* acct.signTransaction(new Uint8Array([1]));
			expect(calls.map((c) => c.tag)).toEqual([
				'once:enter',
				'once:exit',
				'once:enter',
				'once:exit',
			]);
		}).pipe(Effect.provide(layerLeaseBroker)),
	);

	it.effect(
		'broker key encoding uses the `account:<address>` convention with the account name as owner',
		() =>
			Effect.gen(function* () {
				const address = '0xddd';
				// Gate parks the signer body so the test can observe the
				// in-flight lease before it releases.
				const gate = makeGate();
				const signer = makeStubSigner(address, gate, [], 'probe');
				const acct = yield* acquire('dave', signer);

				const broker = yield* LeaseBrokerService;
				const fiber = yield* Effect.forkChild(acct.signTransaction(new Uint8Array([0])));
				yield* Effect.yieldNow;
				yield* Effect.yieldNow;
				const snapshot = yield* broker.holders();
				// Key shape + owner shape pin the plugin convention so
				// cross-plugin consumers (renderer, debug logs) can
				// identify the origin of a held lease.
				expect(snapshot.get(leaseKey(`account:${address}`))).toBe('dave');

				gate.release();
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(layerLeaseBroker)),
	);
});
