// CapabilitySinks — kind→sink registry tests.
//
// Architecture invariants under test:
//   1. Registered sinks dispatch through the same `registerSink` /
//      `dispatch` API.
//   2. A plugin-author-supplied sink can extend the registry with a
//      custom kind; built-in dispatch is unaffected.
//   3. Unknown kinds raise the typed `UnknownContributionKind` error.
//   4. The `error-contribution` sink folds plugin error contributions
//      into the FormatterRegistry the cascade formatter consumes.

import { Deferred, Effect, Exit, Fiber, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	CapabilitySinksService,
	FormatterRegistryService,
	layerCapabilitySinks,
	layerCapabilitySinksDefault,
	type AnyContribution,
	type CapabilitySink,
	type ContributionKind,
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

const orchestratorSink = <K extends ContributionKind, TDecl>(
	sink: CapabilitySink<K, TDecl>,
): OrchestratorSinks[number] => sink as OrchestratorSinks[number];

/** Extract the failure error `_tag`s from a failed `Exit` cause. Mirrors
 *  the inline cause-walking the other dispatch tests use: each `Fail`
 *  reason carries the typed error under `.error`. */
const failureTags = (exit: Exit.Exit<unknown, unknown>): ReadonlyArray<string | undefined> => {
	if (exit._tag !== 'Failure') return [];
	const reasons = (
		exit.cause as unknown as {
			reasons: ReadonlyArray<{ _tag: string; error?: { _tag: string } }>;
		}
	).reasons;
	return reasons.map((r) => (r._tag === 'Fail' ? r.error?._tag : r._tag));
};

const snapDecl: SnapshotableDecl = {
	kind: 'snapshotable',
	subtrees: ['runtime/x'],
	missingTolerance: 'fine',
};

const routeDecl: RoutableDecl = {
	kind: 'routable',
	endpointName: 'demo-endpoint',
	dispatchId: { serviceKey: 'demo', role: 'app' },
	upstream: { type: 'host-loopback', port: 6173 },
	wireProtocol: 'http',
	cors: false,
};

describe('CapabilitySinksService', () => {
	it.effect('dispatch routes a snapshotable decl to the registered sink', () =>
		Effect.gen(function* () {
			const captured = yield* Ref.make<ReadonlyArray<{ key: string; subtree: string }>>([]);
			const orchestrator: OrchestratorSinks = [
				orchestratorSink<'snapshotable', SnapshotableDecl>({
					kind: 'snapshotable',
					accept: (decl, ctx) =>
						Ref.update(captured, (xs) => [
							...xs,
							{ key: String(ctx.pluginKey), subtree: decl.subtrees[0]! },
						]),
				}),
			];
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
			const orchestrator: OrchestratorSinks = [
				orchestratorSink<'routable', RoutableDecl>({
					kind: 'routable',
					accept: (decl, ctx) =>
						Ref.update(captured, (xs) => [
							...xs,
							{ key: String(ctx.pluginKey), role: decl.dispatchId.role },
						]),
				}),
			];
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
				const strategySink = orchestratorSink<
					'strategy-contributor',
					StrategyContributorDecl<string, unknown>
				>({
					kind: 'strategy-contributor',
					accept: (decl, ctx) =>
						Effect.gen(function* () {
							yield* ctx.registerStrategy(decl);
							yield* ctx.publish({
								tag: 'strategy.registered',
								capabilityKey: decl.capabilityKey,
								autoMounted: decl.autoMounted,
								at: 1,
							});
							yield* Effect.addFinalizer(() =>
								ctx.publish({
									tag: 'strategy.unregistered',
									capabilityKey: decl.capabilityKey,
									at: 2,
								}),
							);
						}),
				});

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
					}).pipe(Effect.provide(layerCapabilitySinksDefault([strategySink]))),
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
				}).pipe(Effect.provide(layerCapabilitySinksDefault())),
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
				}).pipe(Effect.provide(layerCapabilitySinksDefault())),
			);

			expect(snapshot.has('AlphaError')).toBe(true);
			expect(snapshot.has('BetaError')).toBe(true);
			const alpha = snapshot.get('AlphaError')!;
			expect(alpha({ _tag: 'AlphaError' }, () => '')).toBe('<<custom AlphaError>>');
		}),
	);

	// Regression for Phase B1: registerSink lands its drop-by-seq
	// finalizer on the AMBIENT scope (the `Scope.Scope` in its R-channel),
	// not on the registry layer's own scope. So when a transient inner
	// scope closes, the sink it registered MUST be reaped while the
	// registry itself (and any sibling registration) survives.
	//
	// Falsifiability: this test provides the registry layer ONCE at the
	// OUTER level so the registry `Ref` outlives the inner scope, then
	// drives the SAME service instance after the inner scope closes. If
	// the drop-by-seq finalizer were deleted, the sink would survive the
	// inner-scope close and the post-close dispatch would route to it
	// (succeeding) instead of failing with `UnknownContributionKind` —
	// failing this test. (The previous version of this block provided the
	// layer INSIDE `Effect.scoped`, so the registry itself died with the
	// inner scope and a vacuous "fresh registry lacks the sink" check
	// passed regardless of the finalizer.)
	it.effect('registerSink finalizer reaps the sink on inner-scope close', () =>
		Effect.gen(function* () {
			const captured = yield* Ref.make<ReadonlyArray<string>>([]);
			const customSink: CapabilitySink<'reaped-probe', { kind: 'reaped-probe'; value: string }> = {
				kind: 'reaped-probe',
				accept: (decl) => Ref.update(captured, (xs) => [...xs, decl.value]),
			};

			const sinks = yield* CapabilitySinksService;

			// Open a transient inner scope, register the sink, dispatch
			// through it while the scope is open, then let the scope close.
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* sinks.registerSink(customSink);
					expect(yield* sinks.knownKinds).toContain('reaped-probe');
					yield* sinks.dispatch(
						{
							source: 'capability',
							decl: { kind: 'reaped-probe', value: 'in-scope' } as unknown as never,
						},
						ctxFor('plug-reaped'),
					);
				}),
			);

			// The in-scope dispatch fired exactly once...
			expect(yield* Ref.get(captured)).toEqual(['in-scope']);
			// ...and the inner-scope close reaped the registration on the
			// STILL-LIVE registry: the kind is gone and a post-close
			// dispatch now lands on the empty registry, raising the typed
			// UnknownContributionKind rather than re-invoking the (leaked)
			// sink.
			expect(yield* sinks.knownKinds).not.toContain('reaped-probe');
			const exit = yield* Effect.exit(
				sinks.dispatch(
					{
						source: 'capability',
						decl: { kind: 'reaped-probe', value: 'post-close' } as unknown as never,
					},
					ctxFor('plug-reaped'),
				),
			);
			expect(failureTags(exit)).toContain('UnknownContributionKind');
			// The sink was NOT re-invoked after its scope closed.
			expect(yield* Ref.get(captured)).toEqual(['in-scope']);
		}).pipe(Effect.scoped, Effect.provide(layerCapabilitySinksDefault())),
	);

	// Companion: the register body is `Effect.uninterruptible` and arms
	// its drop-by-seq finalizer atomically with the append. Driving the
	// REAL interrupt path: fork a fiber that registers inside an inner
	// scope and then parks; once registration is observed (handshake
	// Deferred), interrupt the fiber. Interruption closes the forked
	// fiber's inner scope, which MUST run the finalizer and reap the sink.
	// Falsifiable: delete the finalizer and the sink survives the
	// interrupt, so the post-interrupt dispatch succeeds instead of
	// raising UnknownContributionKind.
	it.effect('interrupting the registering fiber still reaps the sink', () =>
		Effect.gen(function* () {
			const captured = yield* Ref.make<ReadonlyArray<string>>([]);
			const registered = yield* Deferred.make<void>();
			const customSink: CapabilitySink<
				'interrupt-probe',
				{ kind: 'interrupt-probe'; value: string }
			> = {
				kind: 'interrupt-probe',
				accept: (decl) => Ref.update(captured, (xs) => [...xs, decl.value]),
			};

			const sinks = yield* CapabilitySinksService;

			// The forked fiber registers, signals `registered`, then parks
			// forever inside the inner scope. Interrupting it closes that
			// scope and triggers the registration finalizer.
			const fiber = yield* Effect.scoped(
				Effect.gen(function* () {
					yield* sinks.registerSink(customSink);
					yield* Deferred.succeed(registered, undefined);
					yield* Effect.never;
				}),
			).pipe(Effect.forkChild);

			// Wait until the sink is live, then interrupt the fiber.
			yield* Deferred.await(registered);
			expect(yield* sinks.knownKinds).toContain('interrupt-probe');
			yield* Fiber.interrupt(fiber);
			const exit = yield* Fiber.await(fiber);
			expect(Exit.hasInterrupts(exit)).toBe(true);

			// The interrupt-closed scope reaped the sink: the kind is gone
			// and a fresh dispatch raises the typed miss.
			expect(yield* sinks.knownKinds).not.toContain('interrupt-probe');
			const dispatchExit = yield* Effect.exit(
				sinks.dispatch(
					{
						source: 'capability',
						decl: { kind: 'interrupt-probe', value: 'after-interrupt' } as unknown as never,
					},
					ctxFor('plug-interrupt'),
				),
			);
			expect(failureTags(dispatchExit)).toContain('UnknownContributionKind');
			// The parked sink never accepted anything.
			expect(yield* Ref.get(captured)).toEqual([]);
		}).pipe(Effect.scoped, Effect.provide(layerCapabilitySinksDefault())),
	);

	// Unregistered-kind pin (Task C1 §4): emitting a custom capability decl
	// with no registered sink produces a TYPED error
	// (`UnknownContributionKind`) — NOT a silent no-op. Pins current
	// behavior so a regression to silent-drop fails this test.
	it.effect('dispatch of an unregistered custom kind surfaces UnknownContributionKind', () =>
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const exit = yield* Effect.exit(
				sinks.dispatch(
					{
						source: 'capability',
						decl: { kind: 'never-registered-kind', payload: 1 } as unknown as never,
					},
					ctxFor('plug-unregistered'),
				),
			);
			expect(exit._tag).toBe('Failure');
			if (exit._tag === 'Failure') {
				const reasons = (
					exit.cause as unknown as {
						reasons: ReadonlyArray<{ _tag: string; error?: { _tag: string; kind?: string } }>;
					}
				).reasons;
				const failTags = reasons
					.filter((r) => r._tag === 'Fail')
					.map((r) => r.error?._tag);
				expect(failTags).toContain('UnknownContributionKind');
				const kinds = reasons
					.filter((r) => r._tag === 'Fail')
					.map((r) => r.error?.kind);
				expect(kinds).toContain('never-registered-kind');
			}
		}).pipe(Effect.scoped, Effect.provide(layerCapabilitySinks)),
	);
});
