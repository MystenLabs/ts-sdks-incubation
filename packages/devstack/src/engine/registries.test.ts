import { Cause, Effect, Layer, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import {
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
} from './registries.js';
import { EngineHandle, EngineLive } from './engine.js';
import { makeTag } from '../advanced/tag.js';

describe('registries', () => {
	it.effect('publish writes through to register', () =>
		Effect.gen(function* () {
			yield* EndpointRegistry.publish({ name: 'ep-a', url: 'http://a', kind: 'http' });
			const reg = yield* EndpointRegistry;
			const xs = yield* reg.snapshot;
			expect(xs).toHaveLength(1);
			expect(xs[0]?.name).toBe('ep-a');
		}).pipe(Effect.provide(EndpointRegistryLive)),
	);

	it.effect('requiring(tag) yields the tag first, then resolves the registry', () =>
		Effect.gen(function* () {
			// Publisher tag — registers an endpoint as part of its build.
			const publisher = makeTag(
				'publisher',
				Effect.gen(function* () {
					yield* EndpointRegistry.publish({ name: 'from-publisher', url: 'http://pub' });
					return { ok: true } as const;
				}),
			);

			// Reader uses `requiring(publisher)` — the call yields the
			// publisher (running its build) before resolving the registry,
			// so the snapshot is non-empty by the time we read it.
			const names = yield* Effect.gen(function* () {
				const reg = yield* EndpointRegistry.requiring(publisher);
				const xs = yield* reg.snapshot;
				return xs.map((x) => x.name);
			}).pipe(Effect.provide(publisher.__layer), Effect.provide(EndpointRegistryLive));
			expect(names).toContain('from-publisher');
		}),
	);

	it.effect('publish on PackageRegistry also works', () =>
		Effect.gen(function* () {
			yield* PackageRegistry.publish({ name: 'pkg-a', packageId: '0xdead' });
			const reg = yield* PackageRegistry;
			const xs = yield* reg.snapshot;
			expect(xs[0]?.packageId).toBe('0xdead');
		}).pipe(Effect.provide(PackageRegistryLive)),
	);
});

describe('engine hooks', () => {
	it.effect('makeTag wraps build with acquiring → ready', () =>
		Effect.gen(function* () {
			const tag = makeTag('demo', Effect.succeed({ ok: true } as const));
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'demo' }]);

			// Build the tag's layer — the wrapper should fire markAcquiring then markReady.
			yield* Layer.build(tag.__layer).pipe(Effect.scoped);

			const state = yield* Ref.get(engine.tuiState);
			const demo = state.entries.find((t) => t.key === 'demo');
			expect(demo?.status).toBe('ready');
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('makeTag wraps build with acquiring → failed on error', () =>
		Effect.gen(function* () {
			const tag = makeTag('boom', Effect.fail('nope'));
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'boom' }]);

			const exit = yield* Layer.build(tag.__layer).pipe(Effect.scoped, Effect.exit);
			expect(exit._tag).toBe('Failure');

			const state = yield* Ref.get(engine.tuiState);
			const boom = state.entries.find((t) => t.key === 'boom');
			expect(boom?.status).toBe('failed');
			expect(boom?.error).toBeDefined();
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('markFailed summarizes Cause into a one-line error message', () =>
		Effect.gen(function* () {
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'x' }]);
			yield* engine.markFailed('x', Cause.fail(new Error('boom message')));
			const state = yield* Ref.get(engine.tuiState);
			expect(state.entries[0]?.error).toContain('boom message');
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('failed makeTag also pushes a log entry so the TUI log panel shows the cause', () =>
		Effect.gen(function* () {
			// The TUI status row is short — only the first error line. The log
			// panel carries the umbrella message so the user can correlate
			// per-primitive failures even after the row is overwritten by a
			// later transition.
			const tag = makeTag('logging-boom', Effect.fail(new Error('docker not reachable')));
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'logging-boom' }]);

			yield* Layer.build(tag.__layer).pipe(Effect.scoped, Effect.exit);

			const state = yield* Ref.get(engine.tuiState);
			expect(state.logs.length).toBeGreaterThan(0);
			const last = state.logs[state.logs.length - 1];
			expect(last?.level).toBe('error');
			expect(last?.message).toContain('logging-boom');
			expect(last?.message).toContain('docker not reachable');
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('display selector runs once on markReady and the output lands on the entry', () =>
		Effect.gen(function* () {
			// Guards the contract: a tag built with `{kind, display}` should
			// have its display projection captured into title/primary/extras
			// at the ready transition, not on every Ref read.
			let calls = 0;
			const tag = makeTag(
				'serv',
				Effect.succeed({ url: 'http://localhost:1234', name: 'serv' } as const),
				{
					kind: 'service',
					display: (s) => {
						calls += 1;
						return { title: `serv ${s.name}`, primary: s.url };
					},
				},
			);
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'serv', kind: 'service' }]);
			yield* Layer.build(tag.__layer).pipe(Effect.scoped);
			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'serv');
			expect(entry?.title).toBe('serv serv');
			expect(entry?.primary).toBe('http://localhost:1234');
			expect(entry?.kind).toBe('service');
			expect(calls).toBe(1);
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('appendLog trims the buffer to LOG_BUFFER_LIMIT so long runs stay bounded', () =>
		Effect.gen(function* () {
			const engine = yield* EngineHandle;
			// 250 entries is comfortably over the 200 cap; the older 50 should
			// fall off and `entry-249>` (most recent) should still be present.
			for (let i = 0; i < 250; i++) {
				yield* engine.appendLog({ ts: Date.now(), level: 'info', message: `entry-${i}>` });
			}
			const state = yield* Ref.get(engine.tuiState);
			expect(state.logs.length).toBeLessThanOrEqual(200);
			const messages = state.logs.map((l) => l.message);
			expect(messages).toContain('entry-249>');
			expect(messages).not.toContain('entry-0>');
		}).pipe(Effect.provide(EngineLive)),
	);
});
