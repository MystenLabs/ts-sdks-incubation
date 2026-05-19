// Action(name, opts) — cache hit / miss / invalidation behavior under
// the `onChainArtifact` substrate.
//
// Phase C migration shifted Action onto the unified
// publish-cache-verify-register shape:
//
//   - Namespace is bare `'action'` (Phase B contract); per-instance
//     distinction comes from the hashed inputs (name + signer.address +
//     needs[].key + optional `cacheKey`).
//   - Cache key shape is `action/<chainId>/<inputsHash>` (the canonical
//     `withCache` layout) — NOT the prior bespoke
//     `tx/<name>/<chainId>/<address>/<userKey>` shape.
//   - Verify probes `ChainProbe.getTransaction(cached.digest)` — if the
//     digest no longer resolves the entry evicts and the action re-fires.
//   - Every `Action(...)` is cached now (the previous "no cacheKey →
//     always run" branch is gone). Tests that exercised the un-cached
//     branch now assert the cache-hit behaviour instead.

import { Effect, Layer, Option, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Action } from './action.js';
import { SuiTag, type Sui } from './sui.js';
import { ChainProbe } from '../engine/chain-probe.js';
import { StateStore, type StateStoreShape } from '../engine/state-store.js';
import type { Account, SuiObjectChange, TxResult } from '../engine/shared.js';
import { tag, type LayeredTag } from '../advanced/tag.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// In-memory StateStore. Captures every put/remove call so tests can assert
// which side of the cache branch fired.
interface MockStateStore {
	readonly layer: Layer.Layer<StateStore>;
	readonly puts: Array<{ key: string; value: unknown }>;
	readonly removes: Array<string>;
	readonly gets: Array<string>;
	readonly seed: (key: string, value: unknown) => void;
}

const makeMockStateStore = (): MockStateStore => {
	const data = new Map<string, unknown>();
	const puts: Array<{ key: string; value: unknown }> = [];
	const removes: Array<string> = [];
	const gets: Array<string> = [];
	const impl: StateStoreShape = {
		get: <T = unknown>(key: string) =>
			Effect.sync(() => {
				gets.push(key);
				return data.has(key)
					? (Option.some(data.get(key) as T) as Option.Option<T>)
					: (Option.none() as Option.Option<T>);
			}),
		put: <T>(key: string, value: T) =>
			Effect.sync(() => {
				puts.push({ key, value });
				data.set(key, value);
			}),
		remove: (key: string) =>
			Effect.sync(() => {
				removes.push(key);
				data.delete(key);
			}),
	};
	return {
		layer: Layer.succeed(StateStore, impl),
		puts,
		removes,
		gets,
		seed: (k, v) => data.set(k, v),
	};
};

// Mock Sui. `client.core` is empty — the chain probe layer below decides
// whether `getTransaction` resolves; the action surface only consults Sui
// for `chainId`.
const mockSuiLayer = (chainId: string = 'mock-chain-A'): Layer.Layer<SuiTag> =>
	Layer.succeed(SuiTag, {
		network: 'localnet',
		rpc: { host: 'http://localhost:9000' },
		chainId,
		client: { core: {} } as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
		runtime: 'bundled',
	});

// Mock ChainProbe — `getTransaction` is the only surface verify probes
// the action calls. Defaults to "digest resolves" (returns the digest),
// which makes cache hits pass verify. Tests that want verify-fail pass
// `getTransaction: () => Effect.succeed(undefined)` to force a re-fire.
const mockChainProbeLayer = (
	overrides: Partial<typeof ChainProbe.Service> = {},
): Layer.Layer<ChainProbe> =>
	Layer.succeed(ChainProbe, {
		getObject: () => Effect.succeed(undefined),
		getObjectStrict: () => Effect.succeed(undefined),
		objectsMatchTypes: () => Effect.succeed(true),
		getTransaction: (digest: string) => Effect.succeed({ digest }),
		...overrides,
	});

// Minimal mock signer satisfying `Account` shape that records every
// signAndExecute call. Build returns a deterministic TxResult so the
// cache-hit / miss assertions can pin field values.
const makeMockSigner = (address: string): { signer: Account; signCalls: Array<unknown> } => {
	const signCalls: Array<unknown> = [];
	const txResult: TxResult = {
		digest: 'mock-digest-' + Math.random().toString(36).slice(2, 8),
		effects: { status: { status: 'success' } },
		objectChanges: [
			{
				type: 'created',
				objectId: '0xdead',
				sender: address,
				owner: { AddressOwner: address },
				objectType: '0x2::object::ID',
				digest: 'd',
				version: '1',
			} as unknown as SuiObjectChange,
		],
		balanceChanges: undefined,
	};
	const signer: Account = {
		name: 'mock',
		address,
		publicKey: new Uint8Array([1, 2, 3]),
		scheme: 'ed25519',
		signAndExecute: (transaction) =>
			Effect.sync(() => {
				signCalls.push(transaction);
				return txResult;
			}),
		signTransaction: () => Effect.succeed({ signature: 'sig', bytes: 'b' }),
		signPersonalMessage: () => Effect.succeed({ signature: 'sig', bytes: 'b' }),
	};
	return { signer, signCalls };
};

// Action's `opts.signer` expects a yieldable LayeredTag. `tag(...)` produces
// one without dragging in the AccountRegistry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const accountRef = (signer: Account): LayeredTag<any, Account, never, never> =>
	tag('test-account', Effect.succeed(signer)) as unknown as LayeredTag<any, Account, never, never>;

// Build a full provided layer for the action and yield it. Encapsulates
// the layer-composition boilerplate so each test reads as
// "given action X, when acquired with these layers, then ...".
const acquireAction = <A>(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	action: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	accRef: any,
	suiLayer: Layer.Layer<SuiTag>,
	stateLayer: Layer.Layer<StateStore>,
	probeLayer: Layer.Layer<ChainProbe> = mockChainProbeLayer(),
): Effect.Effect<A, unknown, never> =>
	Effect.gen(function* () {
		return yield* action;
	}).pipe(
		Effect.provide(
			Layer.provide(
				action.__layer,
				Layer.mergeAll(
					suiLayer,
					stateLayer,
					probeLayer,
					Layer.provide(accRef.__layer, suiLayer),
				),
			),
		),
	) as Effect.Effect<A, unknown, never>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Action — cache miss', () => {
	it.effect('runs build + sign on first acquire and persists the TxResult', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			let buildRuns = 0;
			const action = Action('do-thing', {
				signer: accRef,
				cacheKey: 'k1',
				build: () =>
					Effect.sync(() => {
						buildRuns += 1;
					}),
			});

			const state = makeMockStateStore();
			const sui = mockSuiLayer();
			const result = yield* acquireAction<TxResult>(action, accRef, sui, state.layer);

			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
			// One persisted entry under the canonical `action/<chainId>/<hash>`
			// shape. Cache-key derivation is opaque (content-hash of inputs);
			// the assertion below pins the prefix shape without coupling to
			// the hash itself.
			expect(state.puts).toHaveLength(1);
			expect(state.puts[0]!.key).toMatch(/^action\/mock-chain-A\/[0-9a-f]{16}$/);
			expect((state.puts[0]!.value as TxResult).digest).toBe(result.digest);
		}),
	);

	it.effect('every Action is cached — omitting cacheKey still persists a TxResult', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			let buildRuns = 0;
			const action = Action('uncached', {
				signer: accRef,
				build: () =>
					Effect.sync(() => {
						buildRuns += 1;
					}),
			});

			const state = makeMockStateStore();
			const sui = mockSuiLayer();
			yield* acquireAction<TxResult>(action, accRef, sui, state.layer);

			// Behaviour change from the pre-substrate shape: every Action
			// goes through the cache now. Idempotency against
			// `(name, signer.address, needs[].key)` is the load-bearing
			// property; callers that need to force a re-fire pass a
			// dynamic `cacheKey`.
			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
			expect(state.puts).toHaveLength(1);
			expect(state.puts[0]!.key).toMatch(/^action\/mock-chain-A\/[0-9a-f]{16}$/);
		}),
	);
});

describe('Action — cache hit', () => {
	it.effect('second run with the same cacheKey skips build and returns the cached TxResult', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			let buildRuns = 0;
			const action = Action('cached', {
				signer: accRef,
				cacheKey: 'stable',
				build: () =>
					Effect.sync(() => {
						buildRuns += 1;
					}),
			});

			const state = makeMockStateStore();
			const sui = mockSuiLayer();

			// First run — cache miss, populates state.
			const first = yield* acquireAction<TxResult>(action, accRef, sui, state.layer);
			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);

			// Second run — cache hit, no fresh build / sign / persist.
			const second = yield* acquireAction<TxResult>(action, accRef, sui, state.layer);
			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
			// Cached TxResult returned verbatim (same digest).
			expect(second.digest).toBe(first.digest);
			// No additional puts — the hit returns existing state untouched.
			expect(state.puts).toHaveLength(1);
		}),
	);

	it.effect('cache hit evicts the entry and re-runs when getTransaction returns undefined', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			let buildRuns = 0;
			const action = Action('cached-stale', {
				signer: accRef,
				cacheKey: 'stable',
				build: () =>
					Effect.sync(() => {
						buildRuns += 1;
					}),
			});

			const state = makeMockStateStore();
			// Pre-populate with a stale TxResult under what we expect the
			// substrate to derive as the key. Use a wildcard probe via the
			// state seed indirection — seed at the SAME key the action will
			// compute by running it once with a verify-pass mock, capturing
			// the key, then resetting.
			const sui = mockSuiLayer();
			const primeRun = yield* acquireAction<TxResult>(action, accRef, sui, state.layer);
			// `primeRun` has the same digest as the cached entry seeded
			// during this first-run pass.
			void primeRun;
			expect(state.puts).toHaveLength(1);
			const cachedKey = state.puts[0]!.key;

			// Reset call counters; second cycle uses a verify-fail probe so
			// the cached entry must evict and the action re-fires.
			signCalls.length = 0;
			state.puts.length = 0;
			state.removes.length = 0;
			buildRuns = 0;

			yield* acquireAction<TxResult>(
				action,
				accRef,
				sui,
				state.layer,
				mockChainProbeLayer({ getTransaction: () => Effect.succeed(undefined) }),
			);

			// Verify-fail path: build ran (re-fire), sign ran, the stale
			// entry was removed and the fresh result re-persisted.
			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
			expect(state.removes).toContain(cachedKey);
			expect(state.puts).toHaveLength(1);
		}),
	);
});

describe('Action — cache key invalidation', () => {
	it.effect('different userKey produces a different cache key (build re-runs)', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			const action1 = Action('k', { signer: accRef, cacheKey: 'v1', build: () => Effect.void });
			const action2 = Action('k', { signer: accRef, cacheKey: 'v2', build: () => Effect.void });

			const state = makeMockStateStore();
			const sui = mockSuiLayer();

			yield* acquireAction<TxResult>(action1, accRef, sui, state.layer);
			yield* acquireAction<TxResult>(action2, accRef, sui, state.layer);

			expect(signCalls).toHaveLength(2);
			expect(state.puts).toHaveLength(2);
			// Two distinct keys under the canonical
			// `action/<chainId>/<hash>` shape.
			expect(state.puts[0]!.key).not.toBe(state.puts[1]!.key);
			expect(state.puts[0]!.key).toMatch(/^action\/mock-chain-A\/[0-9a-f]{16}$/);
			expect(state.puts[1]!.key).toMatch(/^action\/mock-chain-A\/[0-9a-f]{16}$/);
		}),
	);

	it.effect('different chainId produces a different cache key (regenesis invalidation)', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			const action = Action('regen', {
				signer: accRef,
				cacheKey: 'same',
				build: () => Effect.void,
			});

			const state = makeMockStateStore();
			// First chain.
			yield* acquireAction<TxResult>(action, accRef, mockSuiLayer('chain-A'), state.layer);
			// Second chain (regenesis).
			yield* acquireAction<TxResult>(action, accRef, mockSuiLayer('chain-B'), state.layer);

			expect(signCalls).toHaveLength(2);
			// `chainId` lives in the middle slot of the canonical key
			// shape — two distinct chainIds carry two distinct keys.
			expect(state.puts).toHaveLength(2);
			expect(state.puts[0]!.key).toMatch(/^action\/chain-A\/[0-9a-f]{16}$/);
			expect(state.puts[1]!.key).toMatch(/^action\/chain-B\/[0-9a-f]{16}$/);
		}),
	);
});

describe('Action — cacheKey as Effect', () => {
	it.effect('Effect-form cacheKey is yielded and folded into the persistence key', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			// Counter Ref-effect so we can verify the cacheKey effect runs
			// (and runs at acquire-time, not pre-construction).
			const counter = yield* Ref.make(0);
			const action = Action('eff-key', {
				signer: accRef,
				cacheKey: Effect.gen(function* () {
					yield* Ref.update(counter, (n) => n + 1);
					return 'eff-derived';
				}),
				build: () => Effect.void,
			});

			const state = makeMockStateStore();
			const sui = mockSuiLayer();
			yield* acquireAction<TxResult>(action, accRef, sui, state.layer);

			expect(yield* Ref.get(counter)).toBe(1);
			expect(state.puts).toHaveLength(1);
			expect(state.puts[0]!.key).toMatch(/^action\/mock-chain-A\/[0-9a-f]{16}$/);
		}),
	);

	it.effect('Effect-form cacheKey hits the cache on the second acquire (no double build)', () =>
		Effect.gen(function* () {
			const kp = Ed25519Keypair.generate();
			const { signer, signCalls } = makeMockSigner(kp.getPublicKey().toSuiAddress());
			const accRef = accountRef(signer);

			let cacheKeyEvals = 0;
			let buildRuns = 0;
			const action = Action('eff-hit', {
				signer: accRef,
				cacheKey: Effect.sync(() => {
					cacheKeyEvals += 1;
					return 'same';
				}),
				build: () =>
					Effect.sync(() => {
						buildRuns += 1;
					}),
			});

			const state = makeMockStateStore();
			const sui = mockSuiLayer();

			yield* acquireAction<TxResult>(action, accRef, sui, state.layer);
			yield* acquireAction<TxResult>(action, accRef, sui, state.layer);

			// Each acquire evaluates cacheKey exactly once; the second
			// acquire's evaluation finds the persisted entry and short-
			// circuits before build / sign.
			expect(cacheKeyEvals).toBe(2);
			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
		}),
	);
});
