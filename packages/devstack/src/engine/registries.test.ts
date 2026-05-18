import { Cause, Effect, Layer, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import {
	EndpointRegistry,
	EndpointRegistryLive,
	PackageRegistry,
	PackageRegistryLive,
	publishEndpoint,
	publishPackage,
	requireEndpointRegistry,
} from './registries.js';
import { EngineHandle, EngineLive } from './engine.js';
import { tag } from '../advanced/tag.js';

describe('registries', () => {
	it.effect('publishEndpoint writes through to register', () =>
		Effect.gen(function* () {
			yield* publishEndpoint({ name: 'ep-a', url: 'http://a', kind: 'http' });
			const reg = yield* EndpointRegistry;
			const xs = yield* reg.snapshot;
			expect(xs).toHaveLength(1);
			expect(xs[0]?.name).toBe('ep-a');
		}).pipe(Effect.provide(EndpointRegistryLive)),
	);

	it.effect('requireEndpointRegistry(tag) yields the tag first, then resolves the registry', () =>
		Effect.gen(function* () {
			// Publisher tag — registers an endpoint as part of its build.
			const publisher = tag(
				'publisher',
				Effect.gen(function* () {
					yield* publishEndpoint({ name: 'from-publisher', url: 'http://pub' });
					return { ok: true } as const;
				}),
			);

			// Reader uses `requireEndpointRegistry(publisher)` — the call yields
			// the publisher (running its build) before resolving the registry,
			// so the snapshot is non-empty by the time we read it.
			const names = yield* Effect.gen(function* () {
				const reg = yield* requireEndpointRegistry(publisher);
				const xs = yield* reg.snapshot;
				return xs.map((x) => x.name);
			}).pipe(Effect.provide(publisher.__layer), Effect.provide(EndpointRegistryLive));
			expect(names).toContain('from-publisher');
		}),
	);

	it.effect('publishPackage works', () =>
		Effect.gen(function* () {
			yield* publishPackage({ name: 'pkg-a', packageId: '0xdead' });
			const reg = yield* PackageRegistry;
			const xs = yield* reg.snapshot;
			expect(xs[0]?.packageId).toBe('0xdead');
		}).pipe(Effect.provide(PackageRegistryLive)),
	);
});

describe('engine hooks', () => {
	it.effect('tag wraps build with acquiring → ready', () =>
		Effect.gen(function* () {
			const demoTag = tag('demo', Effect.succeed({ ok: true } as const));
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'demo' }]);

			// Build the tag's layer — the wrapper should fire markAcquiring then markReady.
			yield* Layer.build(demoTag.__layer).pipe(Effect.scoped);

			const state = yield* Ref.get(engine.tuiState);
			const demo = state.entries.find((t) => t.key === 'demo');
			expect(demo?.status).toBe('ready');
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('tag wraps build with acquiring → failed on error', () =>
		Effect.gen(function* () {
			const boomTag = tag('boom', Effect.fail('nope'));
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'boom' }]);

			const exit = yield* Layer.build(boomTag.__layer).pipe(Effect.scoped, Effect.exit);
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

	it.effect('failed tag also pushes a log entry so the TUI log panel shows the cause', () =>
		Effect.gen(function* () {
			// The TUI status row is short — only the first error line. The log
			// panel carries the umbrella message so the user can correlate
			// per-primitive failures even after the row is overwritten by a
			// later transition.
			const loggingBoomTag = tag('logging-boom', Effect.fail(new Error('docker not reachable')));
			const engine = yield* EngineHandle;
			yield* engine.seedTags([{ key: 'logging-boom' }]);

			yield* Layer.build(loggingBoomTag.__layer).pipe(Effect.scoped, Effect.exit);

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
			const servTag = tag(
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
			yield* Layer.build(servTag.__layer).pipe(Effect.scoped);
			const state = yield* Ref.get(engine.tuiState);
			const entry = state.entries.find((e) => e.key === 'serv');
			expect(entry?.title).toBe('serv serv');
			expect(entry?.primary).toBe('http://localhost:1234');
			expect(entry?.kind).toBe('service');
			expect(calls).toBe(1);
		}).pipe(Effect.provide(EngineLive)),
	);

	it.effect('hidden: true skips engine entries (no row), but build still runs', () =>
		Effect.gen(function* () {
			// `gitFetch` and other cache-warming primitives mark themselves
			// `hidden: true` so they don't surface as TUI rows — the row
			// added clutter without actionable state. The build body must
			// still execute (the consumer relies on the resolved value).
			let buildRan = false;
			const hiddenTag = tag(
				'hidden-thing',
				Effect.sync(() => {
					buildRan = true;
					return { ok: true } as const;
				}),
				{ hidden: true },
			);
			const engine = yield* EngineHandle;
			// Deliberately skip seeding `hidden-thing` to mirror what the
			// supervisor does (seedEntries flatMap filters __hidden).
			yield* engine.seedTags([{ key: 'visible' }]);

			yield* Layer.build(hiddenTag.__layer).pipe(Effect.scoped);

			expect(buildRan).toBe(true);
			const state = yield* Ref.get(engine.tuiState);
			// No row should have been auto-registered for the hidden key.
			expect(state.entries.find((e) => e.key === 'hidden-thing')).toBeUndefined();
			// `__hidden` is stamped on the Ref so the supervisor's seed pass
			// can filter it out before reaching the engine.
			expect((hiddenTag as { readonly __hidden?: boolean }).__hidden).toBe(true);
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
