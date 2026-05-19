// Action(name, opts) — cache hit / miss / invalidation behavior.
//
// The cache key folds `sui.chainId` + `signer.address` with the user-
// supplied `cacheKey` (string or Effect form). On a hit the cached
// TxResult is probed against the chain; if the probe says `'valid'` we
// short-circuit and skip build + sign + execute. On miss we run the
// build, sign, execute, and persist the result.
//
// The `snapshot.docker.test.ts` integration verifies the hit-log appears
// in stdout against a real localnet; this file unit-tests the branches
// directly with mock Sui + an in-memory StateStore.

import { Effect, Layer, Option, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Action } from './action.js';
import { SuiTag, type Sui } from './sui.js';
import { StateStore, type StateStoreShape } from '../engine/state-store.js';
import type { Account, SuiObjectChange, TxResult } from '../engine/shared.js';
import { tag, type LayeredTag } from '../advanced/tag.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// In-memory StateStore. Captures every put/remove call so tests can assert
// which side of the cache branch fired. The real impl serializes via
// JSON+bigint, but the cache path only round-trips JSON-shaped TxResults
// so a Map roundtrip is behaviorally identical.
interface MockStateStore {
	readonly layer: Layer.Layer<StateStore>;
	readonly puts: Array<{ key: string; value: unknown }>;
	readonly removes: Array<string>;
	readonly seed: (key: string, value: unknown) => void;
}

const makeMockStateStore = (): MockStateStore => {
	const data = new Map<string, unknown>();
	const puts: Array<{ key: string; value: unknown }> = [];
	const removes: Array<string> = [];
	const impl: StateStoreShape = {
		get: <T = unknown>(key: string) =>
			Effect.sync(() =>
				data.has(key)
					? (Option.some(data.get(key) as T) as Option.Option<T>)
					: (Option.none() as Option.Option<T>),
			),
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
		seed: (k, v) => data.set(k, v),
	};
};

// Mock Sui. `client.core.getObject` is the only client field
// `probeCachedTx` touches; the rest is unused by the action surface.
// `getObject` returns success → `'valid'`; throw with
// `code: 'OBJECT_NOT_FOUND'` → `'object-missing'`; throw with anything
// else → `'probe-error'`.
const mockSuiLayer = (
	opts: {
		readonly chainId?: string;
		readonly getObject?: () => Promise<unknown>;
	} = {},
): Layer.Layer<SuiTag> =>
	Layer.succeed(SuiTag, {
		network: 'localnet',
		rpc: { host: 'http://localhost:9000' },
		chainId: opts.chainId ?? 'mock-chain-A',
		client: {
			core: {
				getObject: opts.getObject ?? (() => Promise.resolve({ data: { objectId: '0xdead' } })),
			},
		} as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
		runtime: 'bundled',
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
//
// `action` is typed as `any` because the per-name TagIdentity brand
// (`LayeredTag<'k', ...>` vs `LayeredTag<'regen', ...>`) varies across tests; tightening
// it would force every caller to re-annotate. `accRef` mirrors that
// looseness since it's the same kind of LayeredTag.
const acquireAction = <A>(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	action: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	accRef: any,
	suiLayer: Layer.Layer<SuiTag>,
	stateLayer: Layer.Layer<StateStore>,
): Effect.Effect<A, unknown, never> =>
	Effect.gen(function* () {
		return yield* action;
	}).pipe(
		Effect.provide(
			Layer.provide(
				action.__layer,
				Layer.mergeAll(suiLayer, stateLayer, Layer.provide(accRef.__layer, suiLayer)),
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
			// Persisted under `tx/v1/<name>/<chainId>/<address>/<userKey>`.
			expect(state.puts).toHaveLength(1);
			expect(state.puts[0]!.key).toBe(`tx/v1/do-thing/mock-chain-A/${signer.address}/k1`);
			expect((state.puts[0]!.value as TxResult).digest).toBe(result.digest);
		}),
	);

	it.effect('without cacheKey, build + sign run unconditionally and nothing is persisted', () =>
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

			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
			// Nothing persisted in the no-cacheKey branch.
			expect(state.puts).toHaveLength(0);
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

	it.effect('cache hit evicts the entry and re-runs when the probe sees a missing object', () =>
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
			// Pre-populate with a TxResult whose object id "doesn't exist".
			// `probeCachedTx` calls `getObject`; we configure it to throw
			// OBJECT_NOT_FOUND so the cache entry is treated as stale and
			// evicted.
			const cached: TxResult = {
				digest: 'stale-digest',
				effects: { status: { status: 'success' } },
				objectChanges: [
					{
						type: 'created',
						objectId: '0xstale',
						sender: signer.address,
						owner: { AddressOwner: signer.address },
						objectType: '0x2::object::ID',
						digest: 'd',
						version: '1',
					} as unknown as SuiObjectChange,
				],
				balanceChanges: undefined,
			};
			state.seed(`tx/v1/cached-stale/mock-chain-A/${signer.address}/stable`, cached);

			const sui = mockSuiLayer({
				getObject: () => {
					const err = new Error('not found');
					(err as Error & { code?: string }).code = 'OBJECT_NOT_FOUND';
					return Promise.reject(err);
				},
			});
			yield* acquireAction<TxResult>(action, accRef, sui, state.layer);

			// Build ran (cache evicted), sign ran (action fired fresh).
			expect(buildRuns).toBe(1);
			expect(signCalls).toHaveLength(1);
			// Evict + re-persist.
			expect(state.removes).toContain(`tx/v1/cached-stale/mock-chain-A/${signer.address}/stable`);
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
			expect(state.puts[0]!.key).toBe(`tx/v1/k/mock-chain-A/${signer.address}/v1`);
			expect(state.puts[1]!.key).toBe(`tx/v1/k/mock-chain-A/${signer.address}/v2`);
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
			yield* acquireAction<TxResult>(
				action,
				accRef,
				mockSuiLayer({ chainId: 'chain-A' }),
				state.layer,
			);
			// Second chain (regenesis).
			yield* acquireAction<TxResult>(
				action,
				accRef,
				mockSuiLayer({ chainId: 'chain-B' }),
				state.layer,
			);

			expect(signCalls).toHaveLength(2);
			expect(state.puts.map((p) => p.key)).toEqual([
				`tx/v1/regen/chain-A/${signer.address}/same`,
				`tx/v1/regen/chain-B/${signer.address}/same`,
			]);
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
			expect(state.puts[0]!.key).toBe(`tx/v1/eff-key/mock-chain-A/${signer.address}/eff-derived`);
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
