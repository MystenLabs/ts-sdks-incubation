// CapabilitySinks — kind→sink registry tests.
//
// Architecture invariants under test:
//   1. Built-in sinks (snapshotable/routable/codegenable/strategy-
//      contributor/projection/liveness-classifier/error-contribution)
//      all dispatch through the same `registerSink` /
//      `dispatch` API.
//   2. A plugin-author-supplied sink can extend the registry with a
//      custom kind; built-in dispatch is unaffected.
//   3. Unknown kinds raise the typed `UnknownContributionKind` error.
//   4. The `error-contribution` sink folds plugin error contributions
//      into the FormatterRegistry the cascade formatter consumes.

import { Effect, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	CapabilitySinksService,
	FormatterRegistryService,
	layerCapabilitySinks,
	layerCapabilitySinksDefault,
	type AnyContribution,
	type CapabilitySink,
	type HarvestContext,
	type OrchestratorSinks,
} from '../../../../src/substrate/runtime/index.ts';
import type { SnapshotableDecl } from '../../../../src/contracts/snapshotable.ts';
import type { RoutableDecl } from '../../../../src/contracts/routable.ts';
import type { StrategyContributorDecl } from '../../../../src/contracts/strategy-contributor.ts';
import { appName, chainId, pluginKey, stackName } from '../../../../src/substrate/brand.ts';
import type { Identity } from '../../../../src/substrate/identity.ts';
import type { PluginErrorContribution } from '../../../../src/substrate/plugin.ts';

const fakeIdentity: Identity = {
	app: appName('test-app'),
	stack: stackName('test-stack'),
	chain: chainId('test:local'),
};

const ctxFor = (key: string): HarvestContext => ({
	pluginKey: pluginKey(key),
	identity: fakeIdentity,
	publish: () => Effect.void,
	registerStrategy: () => Effect.void,
});

const snapDecl: SnapshotableDecl = {
	kind: 'snapshotable',
	subtrees: ['runtime/x'],
	missingTolerance: 'fine',
};

const routeDecl: RoutableDecl = {
	kind: 'routable',
	endpointName: 'demo-endpoint',
	dispatchId: { compositeKey: 'demo', role: 'app' },
	upstream: { type: 'host-loopback', port: 6173 },
	wireProtocol: 'http',
	cors: false,
};

describe('CapabilitySinksService', () => {
	it.effect('dispatch routes a snapshotable decl to the registered sink', () =>
		Effect.gen(function* () {
			const captured = yield* Ref.make<ReadonlyArray<{ key: string; subtree: string }>>([]);
			const orchestrator: OrchestratorSinks = {
				snapshotable: (key, decl) =>
					Ref.update(captured, (xs) => [...xs, { key: String(key), subtree: decl.subtrees[0]! }]),
			};
			yield* Effect.scoped(
				Effect.gen(function* () {
					const sinks = yield* CapabilitySinksService;
					yield* sinks.dispatch(
						{ source: 'capability', decl: snapDecl } satisfies AnyContribution,
						ctxFor('plug-a'),
					);
				}).pipe(Effect.provide(layerCapabilitySinksDefault(orchestrator))),
			);
			const got = yield* Ref.get(captured);
			expect(got).toEqual([{ key: 'plug-a', subtree: 'runtime/x' }]);
		}),
	);

	it.effect('orchestrator sink receives the routable decl', () =>
		Effect.gen(function* () {
			const captured = yield* Ref.make<ReadonlyArray<{ key: string; role: string }>>([]);
			const orchestrator: OrchestratorSinks = {
				routable: (key, decl) =>
					Ref.update(captured, (xs) => [...xs, { key: String(key), role: decl.dispatchId.role }]),
			};
			yield* Effect.scoped(
				Effect.gen(function* () {
					const sinks = yield* CapabilitySinksService;
					yield* sinks.dispatch({ source: 'capability', decl: routeDecl }, ctxFor('plug-b'));
				}).pipe(Effect.provide(layerCapabilitySinksDefault(orchestrator))),
			);
			const got = yield* Ref.get(captured);
			expect(got).toEqual([{ key: 'plug-b', role: 'app' }]);
		}),
	);

	it.effect(
		'strategy sink registers through the harvest context and publishes lifecycle events',
		() =>
			Effect.gen(function* () {
				const registered = yield* Ref.make<ReadonlyArray<string>>([]);
				const published = yield* Ref.make<ReadonlyArray<string>>([]);
				const strategyDecl: StrategyContributorDecl<'demo-strategy', { readonly run: () => void }> =
					{
						kind: 'strategy-contributor',
						capabilityKey: 'demo-strategy',
						strategy: { run: () => undefined },
						autoMounted: true,
					};

				yield* Effect.scoped(
					Effect.gen(function* () {
						const sinks = yield* CapabilitySinksService;
						yield* sinks.dispatch(
							{ source: 'capability', decl: strategyDecl },
							{
								...ctxFor('plug-strategy'),
								publish: (event) => Ref.update(published, (tags) => [...tags, event.tag]),
								registerStrategy: (decl) =>
									Ref.update(registered, (keys) => [...keys, decl.capabilityKey]),
							},
						);
						expect(yield* Ref.get(registered)).toEqual(['demo-strategy']);
						expect(yield* Ref.get(published)).toEqual(['strategy.registered']);
					}).pipe(Effect.provide(layerCapabilitySinksDefault({}))),
				);

				expect(yield* Ref.get(published)).toEqual(['strategy.registered', 'strategy.unregistered']);
			}),
	);

	it.effect('unknown kind raises UnknownContributionKind (empty registry)', () =>
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const exit = yield* Effect.exit(
				sinks.dispatch({ source: 'capability', decl: snapDecl }, ctxFor('plug-c')),
			);
			// Failure expected because the bare layerCapabilitySinks doesn't
			// register any sinks — only the Default variant does.
			expect(exit._tag).toBe('Failure');
			if (exit._tag === 'Failure') {
				const reasons = (
					exit.cause as unknown as {
						reasons: ReadonlyArray<{ _tag: string; error?: { _tag: string } }>;
					}
				).reasons;
				const tags = reasons.map((r) => (r._tag === 'Fail' ? r.error?._tag : r._tag));
				expect(tags).toContain('UnknownContributionKind');
			}
		}).pipe(Effect.scoped, Effect.provide(layerCapabilitySinks)),
	);

	it.effect('plugin author may extend the registry with a custom kind', () =>
		Effect.gen(function* () {
			const customCaptured = yield* Ref.make<ReadonlyArray<string>>([]);
			interface CustomDecl {
				readonly kind: 'my-plugin-decl';
				readonly payload: string;
			}
			const customSink: CapabilitySink<'my-plugin-decl', CustomDecl> = {
				kind: 'my-plugin-decl',
				accept: (decl) => Ref.update(customCaptured, (xs) => [...xs, decl.payload]),
			};

			yield* Effect.scoped(
				Effect.gen(function* () {
					const sinks = yield* CapabilitySinksService;
					yield* sinks.registerSink(customSink);
					yield* sinks.dispatch(
						{
							source: 'capability',
							// Cast: custom decl isn't in the CapabilityDecl union, but the
							// substrate dispatches structurally on `kind` — the union
							// is the substrate-owned default, not a closed surface.
							decl: { kind: 'my-plugin-decl', payload: 'hello' } as unknown as never,
						},
						ctxFor('plug-d'),
					);
				}).pipe(Effect.provide(layerCapabilitySinksDefault({}))),
			);

			const captured = yield* Ref.get(customCaptured);
			expect(captured).toEqual(['hello']);
		}),
	);

	it.effect('error-contribution sink folds tags into the FormatterRegistry', () =>
		Effect.gen(function* () {
			const contrib: PluginErrorContribution = {
				_tag: 'PluginErrorContribution',
				errorTags: ['AlphaError', 'BetaError'],
				formatter: (value) => `<<custom ${value._tag}>>`,
			};

			const snapshot = yield* Effect.scoped(
				Effect.gen(function* () {
					const sinks = yield* CapabilitySinksService;
					yield* sinks.dispatch({ source: 'error', contribution: contrib }, ctxFor('plug-e'));
					const fmt = yield* FormatterRegistryService;
					return yield* fmt.snapshot;
				}).pipe(Effect.provide(layerCapabilitySinksDefault({}))),
			);

			expect(snapshot.has('AlphaError')).toBe(true);
			expect(snapshot.has('BetaError')).toBe(true);
			const alpha = snapshot.get('AlphaError')!;
			expect(alpha({ _tag: 'AlphaError' }, () => '')).toBe('<<custom AlphaError>>');
		}),
	);
});
