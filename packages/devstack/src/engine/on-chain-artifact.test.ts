// Unit tests for `onChainArtifact(spec)`.
//
// Pins the contract Phase B+ migrations will observe:
//
//   - Cache miss → produce + register
//   - Cache hit + verify-success → no produce, register still runs
//   - Cache hit + verify-undefined → evict + produce + register
//   - register skipped when undefined
//   - upstream record values flow through to inputs/verify/produce/register as `deps`
//   - upstream auto-flattens into __upstreamKeys
//   - conditional `undefined` upstream entries surface as undefined deps and drop from __upstreamKeys

import { Context, Effect, Layer, Option, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { StateStore } from './state-store.js';
import { onChainArtifact } from './on-chain-artifact.js';
import { SuiTag, type Sui } from '../services/sui.js';
import { ChainProbe } from './chain-probe.js';
import { tag, type LayeredTag } from '../advanced/tag.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const makeFakeSui = (chainId: string = 'chain-a'): Sui =>
	({
		network: 'localnet',
		rpc: { host: 'http://127.0.0.1:9000' },
		chainId,
		runtime: 'bundled',
		client: { core: {} } as unknown as Sui['client'],
		waitForTransactionsReady: () => Effect.void,
	}) as unknown as Sui;

const makeFakeStateStore = () =>
	Effect.gen(function* () {
		const store = yield* Ref.make<Map<string, unknown>>(new Map());
		const ops = yield* Ref.make<Array<string>>([]);
		const layer = Layer.succeed(StateStore, {
			get: <T>(key: string) =>
				Ref.update(ops, (xs) => [...xs, `get(${key})`]).pipe(
					Effect.flatMap(() => Ref.get(store)),
					Effect.map((m) => (m.has(key) ? Option.some(m.get(key) as T) : Option.none<T>())),
				),
			put: <T>(key: string, value: T) =>
				Ref.update(ops, (xs) => [...xs, `put(${key})`]).pipe(
					Effect.andThen(Ref.update(store, (m) => new Map(m).set(key, value))),
				),
			remove: (key: string) =>
				Ref.update(ops, (xs) => [...xs, `remove(${key})`]).pipe(
					Effect.andThen(
						Ref.update(store, (m) => {
							const next = new Map(m);
							next.delete(key);
							return next;
						}),
					),
				),
		});
		return { layer, store, ops };
	});

const noopChainProbe: typeof ChainProbe.Service = {
	getObject: () => Effect.succeed(undefined),
	getObjectStrict: () => Effect.succeed(undefined),
	objectsMatchTypes: () => Effect.succeed(true),
};
const provideChainProbe = (impl: typeof ChainProbe.Service = noopChainProbe) =>
	Effect.provide(Layer.succeed(ChainProbe, impl));

const provideSui = (sui: Sui = makeFakeSui()) => Effect.provide(Layer.succeed(SuiTag, sui));

// Run an `onChainArtifact` layer once and return its value. The
// supervisor normally composes the tag's full `__layers` list via a
// `provideMerge` fold (each layer provides services to layers after it).
const runArtifact = <Name extends string, T, R, E>(
	artifact: LayeredTag<Name, T, R, E>,
	provide: (e: Effect.Effect<T, E, R>) => Effect.Effect<T, E, never>,
): Effect.Effect<T, E, never> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const layers = (artifact.__layers ?? [artifact.__layer]) as ReadonlyArray<Layer.Layer<any, any, any>>;
	// Fold layers left-to-right: each new layer provides services to all
	// layers that come after it. Same shape as `composeStackLayer` uses.
	const [head, ...tail] = layers;
	if (head === undefined) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return provide(Effect.succeed(undefined as any));
	}
	const composed = tail.reduce(
		(acc, l) => Layer.provideMerge(l, acc),
		head as Layer.Layer<any, any, any>,
	);
	return provide(
		Effect.scoped(
			Effect.gen(function* () {
				const ctx = yield* Layer.build(composed);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return Context.get(ctx, artifact as unknown as any) as T;
			}) as Effect.Effect<T, E, R>,
		),
	);
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('onChainArtifact (substrate composition)', () => {
	it.effect('cache miss → produce + register + return', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			const produceRuns = yield* Ref.make(0);
			const registerCalls = yield* Ref.make<Array<{ value: number }>>([]);

			const artifact = onChainArtifact({
				name: 'test/miss',
				plugin: 'test',
				namespace: 'test/miss/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: () => Ref.update(produceRuns, (n) => n + 1).pipe(Effect.as({ value: 42 })),
				register: ({ value }) => Ref.update(registerCalls, (xs) => [...xs, value]),
			});

			const result = yield* runArtifact(artifact, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			expect(result).toEqual({ value: 42 });
			expect(yield* Ref.get(produceRuns)).toBe(1);
			expect(yield* Ref.get(registerCalls)).toEqual([{ value: 42 }]);
		}),
	);

	it.effect('cache hit + verify-success → no produce, register still runs', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			const produceRuns = yield* Ref.make(0);
			const registerCalls = yield* Ref.make<Array<{ value: number }>>([]);

			// First cycle: seed.
			const seed = onChainArtifact({
				name: 'test/hit',
				plugin: 'test',
				namespace: 'test/hit/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: () => Effect.succeed({ value: 7 }),
				register: ({ value }) =>
					Ref.update(registerCalls, (xs) => [...xs, value as { value: number }]),
			});
			yield* runArtifact(seed, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			yield* Ref.set(registerCalls, []);

			// Second cycle: produce that would fail if invoked.
			const check = onChainArtifact({
				name: 'test/hit',
				plugin: 'test',
				namespace: 'test/hit/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: () =>
					Ref.update(produceRuns, (n) => n + 1).pipe(Effect.as({ value: 999 })),
				register: ({ value }) =>
					Ref.update(registerCalls, (xs) => [...xs, value as { value: number }]),
			});
			const result = yield* runArtifact(check, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			expect(result).toEqual({ value: 7 });
			expect(yield* Ref.get(produceRuns)).toBe(0);
			// register MUST fire on cache hit too — load-bearing
			// publishMove `registerAll` semantics.
			expect(yield* Ref.get(registerCalls)).toEqual([{ value: 7 }]);
		}),
	);

	it.effect('cache hit + verify-undefined → evict + produce + register', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			const produceRuns = yield* Ref.make(0);
			const registerCalls = yield* Ref.make<Array<{ value: number }>>([]);

			// Seed first.
			const seed = onChainArtifact({
				name: 'test/evict',
				plugin: 'test',
				namespace: 'test/evict/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: () => Effect.succeed({ value: 1 }),
			});
			yield* runArtifact(seed, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			yield* Ref.set(fake.ops, []);

			// Now verify returns undefined → evict + produce.
			const artifact = onChainArtifact({
				name: 'test/evict',
				plugin: 'test',
				namespace: 'test/evict/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: () => Effect.succeed(undefined),
				produce: () =>
					Ref.update(produceRuns, (n) => n + 1).pipe(Effect.as({ value: 99 })),
				register: ({ value }) =>
					Ref.update(registerCalls, (xs) => [...xs, value as { value: number }]),
			});
			const result = yield* runArtifact(artifact, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			expect(result).toEqual({ value: 99 });
			expect(yield* Ref.get(produceRuns)).toBe(1);
			expect(yield* Ref.get(registerCalls)).toEqual([{ value: 99 }]);
			const ops = yield* Ref.get(fake.ops);
			expect(ops.some((o) => o.startsWith('remove('))).toBe(true);
		}),
	);

	it.effect('register undefined → no register call', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			const artifact = onChainArtifact({
				name: 'test/no-register',
				plugin: 'test',
				namespace: 'test/no-register/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: () => Effect.succeed({ value: 7 }),
			});
			const result = yield* runArtifact(artifact, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			expect(result).toEqual({ value: 7 });
		}),
	);

	it.effect('upstream record values flow as `deps` to every callback', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			// Inner tag with a known resolved shape.
			const innerPkg = tag('inner.pkg', Effect.succeed({ packageId: '0xCAFE' }));
			const observedInputs = yield* Ref.make<unknown>(undefined);
			const observedProduce = yield* Ref.make<unknown>(undefined);
			const observedRegister = yield* Ref.make<unknown>(undefined);

			const artifact = onChainArtifact({
				name: 'test/deps',
				plugin: 'test',
				namespace: 'test/deps/v1',
				upstream: { pkg: innerPkg },
				inputs: (deps) =>
					Effect.gen(function* () {
						yield* Ref.set(observedInputs, deps);
						return { pkgId: deps.pkg.packageId };
					}),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: (deps) =>
					Ref.set(observedProduce, deps).pipe(
						Effect.as({ result: `for-${deps.pkg.packageId}` }),
					),
				register: ({ deps }) => Ref.set(observedRegister, deps),
			});

			const result = yield* runArtifact(artifact, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);
			expect(result).toEqual({ result: 'for-0xCAFE' });
			expect(yield* Ref.get(observedInputs)).toEqual({ pkg: { packageId: '0xCAFE' } });
			expect(yield* Ref.get(observedProduce)).toEqual({ pkg: { packageId: '0xCAFE' } });
			expect(yield* Ref.get(observedRegister)).toEqual({ pkg: { packageId: '0xCAFE' } });
		}),
	);

	it.effect('verify receives the ChainProbe service in deps args', () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeStateStore();
			// Seed.
			const seed = onChainArtifact({
				name: 'test/verify-probe',
				plugin: 'test',
				namespace: 'test/verify-probe/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached }) => Effect.succeed(cached),
				produce: () => Effect.succeed({ id: '0xobj' }),
			});
			yield* runArtifact(seed, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(), provideSui()),
			);

			// Probe sees '0xobj'.
			const customProbe: typeof ChainProbe.Service = {
				...noopChainProbe,
				getObject: (id) =>
					Effect.succeed(
						id === '0xobj'
							? { objectId: '0xobj', type: 'T', version: '1', owner: {} as const }
							: undefined,
					),
			};

			const check = onChainArtifact({
				name: 'test/verify-probe',
				plugin: 'test',
				namespace: 'test/verify-probe/v1',
				upstream: {},
				inputs: () => Effect.succeed({ x: 1 }),
				verify: ({ cached, chain }) =>
					Effect.gen(function* () {
						const info = yield* chain.getObject(cached.id);
						return info !== undefined ? cached : undefined;
					}),
				produce: () => Effect.succeed({ id: '0xother' }),
			});
			const result = yield* runArtifact(check, (e) =>
				e.pipe(Effect.provide(fake.layer), provideChainProbe(customProbe), provideSui()),
			);
			expect(result).toEqual({ id: '0xobj' });
		}),
	);
});

describe('onChainArtifact (tag shape + upstream auto-flatten)', () => {
	it('auto-flattens upstream record values into __upstreamKeys', () => {
		const innerA = tag('inner.a', Effect.succeed(0));
		const innerB = tag('inner.b', Effect.succeed('hi'));
		const artifact = onChainArtifact({
			name: 'shape/upstream',
			plugin: 'test',
			namespace: 'shape/upstream/v1',
			upstream: { a: innerA, b: innerB },
			inputs: () => Effect.succeed({}),
			verify: ({ cached }) => Effect.succeed(cached as undefined),
			produce: () => Effect.succeed(undefined),
		});
		expect(artifact.__upstreamKeys).toContain('inner.a');
		expect(artifact.__upstreamKeys).toContain('inner.b');
	});

	it('conditional undefined upstream entries are dropped from __upstreamKeys', () => {
		const innerA = tag('inner.a2', Effect.succeed(0));
		const artifact = onChainArtifact({
			name: 'shape/conditional',
			plugin: 'test',
			namespace: 'shape/conditional/v1',
			upstream: { a: innerA, b: undefined as undefined | typeof innerA },
			inputs: () => Effect.succeed({}),
			verify: ({ cached }) => Effect.succeed(cached as undefined),
			produce: () => Effect.succeed(undefined),
		});
		expect(artifact.__upstreamKeys).toEqual(['inner.a2']);
	});

	it('stamps plugin / kind / displayTitle through to the LayeredTag', () => {
		const artifact = onChainArtifact({
			name: 'shape/options',
			plugin: 'my-plugin',
			kind: 'action',
			displayTitle: 'publish my-pkg',
			namespace: 'shape/options/v1',
			upstream: {},
			inputs: () => Effect.succeed({}),
			verify: ({ cached }) => Effect.succeed(cached as undefined),
			produce: () => Effect.succeed(undefined),
		});
		expect(artifact.__pluginName).toBe('my-plugin');
		expect(artifact.__kind).toBe('action');
		expect(artifact.__displayTitle).toBe('publish my-pkg');
	});

	it("defaults kind to 'action' when not specified", () => {
		const artifact = onChainArtifact({
			name: 'shape/default-kind',
			plugin: 'test',
			namespace: 'shape/default-kind/v1',
			upstream: {},
			inputs: () => Effect.succeed({}),
			verify: ({ cached }) => Effect.succeed(cached as undefined),
			produce: () => Effect.succeed(undefined),
		});
		expect(artifact.__kind).toBe('action');
	});
});
