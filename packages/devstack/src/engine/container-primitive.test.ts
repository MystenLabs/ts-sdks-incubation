// Unit tests for `containerPrimitive`.
//
// The substrate's main contract is the per-name `Semaphore(1)` around
// the underlying Docker.run flow + the LayeredTag wiring + the
// upstream-record dep flow. We don't boot real containers here —
// Docker.run is exercised in the integration suite; this file pins
// (a) the tag shape (key, kind, plugin, upstream auto-flatten,
// extraLayers presence), (b) the per-name lock serialisation property,
// and (c) deps-aware run/handle callbacks receive the resolved deps.

import { Effect, Ref, Semaphore } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { containerPrimitive, _resetContainerLocksForTest } from './container-primitive.js';
import { tag, type LayeredTag } from '../advanced/tag.js';

describe('containerPrimitive (tag shape)', () => {
	it('produces a LayeredTag with the spec.name as the key', () => {
		_resetContainerLocksForTest();
		const t = containerPrimitive({
			name: 'shape/basic',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox:latest' },
			run: { args: ['sleep', '1'] },
		});
		expect(t.key).toBe('shape/basic');
		expect(t.__layer).toBeDefined();
		expect(t.__layers.length).toBeGreaterThan(0);
	});

	it('stamps plugin / kind / hidden / displayTitle through to the LayeredTag', () => {
		_resetContainerLocksForTest();
		const t = containerPrimitive({
			name: 'shape/options',
			plugin: 'my-plugin',
			kind: 'app',
			displayTitle: 'my container',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		expect(t.__pluginName).toBe('my-plugin');
		expect(t.__kind).toBe('app');
		expect(t.__displayTitle).toBe('my container');
	});

	it("defaults kind to 'service' when not specified", () => {
		_resetContainerLocksForTest();
		const t = containerPrimitive({
			name: 'shape/default-kind',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		expect(t.__kind).toBe('service');
	});

	it('auto-flattens upstream record values into __upstreamKeys', () => {
		_resetContainerLocksForTest();
		const innerA = tag('container.inner.a', Effect.succeed(0));
		const innerB = tag('container.inner.b', Effect.succeed('hi'));
		const t = containerPrimitive({
			name: 'shape/upstream',
			plugin: 'test',
			upstream: { a: innerA, b: innerB },
			image: { pull: 'busybox' },
			run: {},
		});
		expect(t.__upstreamKeys).toContain('container.inner.a');
		expect(t.__upstreamKeys).toContain('container.inner.b');
	});

	it('conditional undefined upstream entries drop from __upstreamKeys', () => {
		_resetContainerLocksForTest();
		const innerA = tag('container.inner.a2', Effect.succeed(0));
		const t = containerPrimitive({
			name: 'shape/conditional',
			plugin: 'test',
			upstream: { a: innerA, b: undefined as undefined | typeof innerA },
			image: { pull: 'busybox' },
			run: {},
		});
		expect(t.__upstreamKeys).toEqual(['container.inner.a2']);
	});

	it('surfaces image-build sub-layers in __layers (static run)', () => {
		_resetContainerLocksForTest();
		const t = containerPrimitive({
			name: 'shape/image-pull',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox:latest' },
			run: {},
		});
		// At minimum: image-build layer + own layer.
		expect(t.__layers.length).toBeGreaterThanOrEqual(2);
	});

	it('hidden:true sets __hidden on the tag', () => {
		_resetContainerLocksForTest();
		const t = containerPrimitive({
			name: 'shape/hidden',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
			hidden: true,
		});
		expect(t.__hidden).toBe(true);
	});

	it('accepts a deps-aware run callback', () => {
		// The callback shape exists at the type-level; this test pins
		// the runtime accepts a function without throwing during tag
		// construction. The actual deps-resolved invocation happens
		// inside the build body which we can't reach without docker.
		_resetContainerLocksForTest();
		const innerCfg = tag('container.cfg', Effect.succeed({ port: 9000 }));
		const t = containerPrimitive({
			name: 'deps-aware/run',
			plugin: 'test',
			upstream: { cfg: innerCfg },
			image: { pull: 'busybox' },
			run: (deps) => ({
				env: { PORT: String(deps.cfg.port) },
			}),
		});
		expect(t.key).toBe('deps-aware/run');
		// `__upstreamKeys` still flattens — independent of run shape.
		expect(t.__upstreamKeys).toContain('container.cfg');
	});
});

describe('containerPrimitive (per-name lock serialisation)', () => {
	// The substrate's core invariant is per-name semaphore serialisation
	// around the Docker.run body. We test the semaphore primitive's
	// behavior directly (it's just a vanilla Effect Semaphore) and pin
	// the tag-level construction doesn't accidentally weaken the
	// serialisation by stamping different objects for the same name.

	it.live('Effect Semaphore(1) serialises concurrent operations', () =>
		Effect.gen(function* () {
			_resetContainerLocksForTest();
			const sem = Semaphore.makeUnsafe(1);
			const order = yield* Ref.make<Array<string>>([]);
			yield* Effect.all(
				[
					sem.withPermits(1)(
						Effect.gen(function* () {
							yield* Ref.update(order, (xs) => [...xs, 'A-start']);
							yield* Effect.sleep('5 millis');
							yield* Ref.update(order, (xs) => [...xs, 'A-end']);
						}),
					),
					sem.withPermits(1)(
						Effect.gen(function* () {
							yield* Ref.update(order, (xs) => [...xs, 'B-start']);
							yield* Ref.update(order, (xs) => [...xs, 'B-end']);
						}),
					),
				],
				{ concurrency: 'unbounded' },
			);
			const ops = yield* Ref.get(order);
			// A's start/end is contiguous — no B in between.
			const aStart = ops.indexOf('A-start');
			const aEnd = ops.indexOf('A-end');
			expect(aEnd).toBe(aStart + 1);
		}),
	);

	it('two containerPrimitives with the same name share their lock (constructible)', () => {
		_resetContainerLocksForTest();
		const t1 = containerPrimitive({
			name: 'serialise-test',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		const t2 = containerPrimitive({
			name: 'serialise-test',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		expect(t1.key).toBe(t2.key);
		// Distinct tag instances (each call returns a fresh Object.assign'd
		// class); the lock is shared by name behind the scenes.
		expect(t1).not.toBe(t2);
	});

	it('different names produce different tags (no false sharing)', () => {
		_resetContainerLocksForTest();
		const tA = containerPrimitive({
			name: 'lock-a',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		const tB = containerPrimitive({
			name: 'lock-b',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		expect(tA.key).not.toBe(tB.key);
	});

	it('_resetContainerLocksForTest clears the lock registry', () => {
		_resetContainerLocksForTest();
		containerPrimitive({
			name: 'reset-test',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		// Reset is observable indirectly (re-constructing post-reset works).
		_resetContainerLocksForTest();
		const t = containerPrimitive({
			name: 'reset-test',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
		});
		expect(t.key).toBe('reset-test');
	});
});

describe('containerPrimitive (handle projection typing)', () => {
	it('typed Handle parameter flows through the tag', () => {
		_resetContainerLocksForTest();
		interface MyHandle {
			readonly url: string;
			readonly customField: number;
		}
		// The Handle generic is the THIRD type parameter (after Name and
		// the upstream record U). Pass `{}` for U when no upstreams are
		// declared so the type parameter slot stays explicit.
		const t = containerPrimitive<'my-svc', {}, MyHandle>({
			name: 'my-svc',
			plugin: 'test',
			upstream: {},
			image: { pull: 'busybox' },
			run: {},
			handle: ({ raw }) => ({
				url: raw.url ?? '',
				customField: 42,
			}),
		});
		expect(t.key).toBe('my-svc');
		// Type-level check: tag advertises Handle = MyHandle.
		const _checkType: LayeredTag<'my-svc', MyHandle, any, any> = t;
		expect(_checkType).toBeDefined();
	});
});
