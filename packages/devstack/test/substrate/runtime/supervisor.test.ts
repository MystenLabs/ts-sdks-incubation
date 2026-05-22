// Supervisor harvest-loop direct tests.
//
// The supervisor's harvest loop is exercised TRANSITIVELY via the
// CapabilitySinks service tests + e2e boot suites. This file pins the
// wiring contract directly: a minimal stack with mixed
// `CapabilityDecl` kinds + `PluginErrorContribution`s is supervised
// to ready, and we assert each contribution reached the matching
// `OrchestratorSinks` callback at the supervisor boundary.
//
// Architecture invariants under test:
//   1. The supervisor's post-acquire harvest walks `member.capabilities`
//      AND `member.errorContributions`, routing each through
//      `CapabilitySinksService.dispatch`.
//   2. The substrate's default sinks adapt each capability `kind`
//      literal to the corresponding optional `OrchestratorSinks`
//      callback. Plugins emitting decls of different kinds dispatch
//      to different callbacks.
//   3. Dispatch occurs once per plugin after acquire succeeds — no
//      duplicate calls; no calls for plugins that failed acquire.
//   4. The supervisor stays name-blind: it walks the `kind` literal
//      and dispatches structurally; the orchestrator callback bag is
//      the ONE place orchestrator names land.

import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	CapabilitySinksService,
	Logger,
	layerCapabilitySinksDefault,
	layerLogger,
	layerRedactor,
	makeProjectionRef,
	startSupervisor,
	supervise,
	type CapabilitySink,
	type OrchestratorSinks,
	type SupervisedStack,
} from '../../../src/substrate/runtime/index.ts';
import { CurrentPluginKey } from '../../../src/substrate/runtime/current-plugin.ts';
import { definePlugin, type PluginErrorContribution } from '../../../src/substrate/plugin.ts';
import type { CodegenableDecl } from '../../../src/contracts/codegenable.ts';
import type { ProjectionDecl } from '../../../src/contracts/projection.ts';
import type { RoutableDecl } from '../../../src/contracts/routable.ts';
import type { SnapshotableDecl } from '../../../src/contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../../src/contracts/strategy-contributor.ts';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const identity: Identity = {
	app: appName('supervisor-test-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

interface Captured {
	readonly snapshotable: ReadonlyArray<{ readonly key: string; readonly subtree: string }>;
	readonly routable: ReadonlyArray<{ readonly key: string; readonly endpoint: string }>;
	readonly codegenable: ReadonlyArray<{ readonly key: string; readonly emitter: string }>;
	readonly strategy: ReadonlyArray<{ readonly key: string; readonly capabilityKey: string }>;
}

const makeCapture = () =>
	Effect.gen(function* () {
		const ref = yield* Ref.make<Captured>({
			snapshotable: [],
			routable: [],
			codegenable: [],
			strategy: [],
		});
		const sinks: OrchestratorSinks = {
			snapshotable: (key, decl) =>
				Ref.update(ref, (c) => ({
					...c,
					snapshotable: [...c.snapshotable, { key: String(key), subtree: decl.subtrees[0] ?? '' }],
				})),
			routable: (key, decl) =>
				Ref.update(ref, (c) => ({
					...c,
					routable: [...c.routable, { key: String(key), endpoint: decl.endpointName }],
				})),
			codegenable: (key, decl) =>
				Ref.update(ref, (c) => ({
					...c,
					codegenable: [...c.codegenable, { key: String(key), emitter: decl.emitterName }],
				})),
			strategy: (key, decl) =>
				Ref.update(ref, (c) => ({
					...c,
					strategy: [...c.strategy, { key: String(key), capabilityKey: decl.capabilityKey }],
				})),
		};
		return { ref, sinks };
	});

// Each plugin provides a distinct resource id and
// declares a single capability `kind`. The supervisor's resolve-graph
// happily acquires each in topological order; we set them all as
// independent leaves so the test exercises the harvest path without
// depending on cross-plugin wiring.

const snapDecl: SnapshotableDecl = {
	kind: 'snapshotable',
	subtrees: ['runtime/snap-subtree'],
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

const codegenDecl: CodegenableDecl<'demo-emitter'> = {
	kind: 'codegenable',
	emitterName: 'demo-emitter',
	outputPath: 'demo/file.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('hello', 'world');
			return ctx.done();
		}),
};

const strategyDecl: StrategyContributorDecl<'demo-strategy', { readonly run: 'ok' }> = {
	kind: 'strategy-contributor',
	capabilityKey: 'demo-strategy',
	strategy: { run: 'ok' },
	autoMounted: false,
};

const accountStrategyDecl: StrategyContributorDecl<
	'account:alice',
	{
		readonly name: 'alice';
		readonly address: '0xabc';
		readonly scheme: 'ed25519';
		readonly source: 'real';
		readonly funding: {
			readonly status: 'funded';
			readonly balanceMist: null;
			readonly requestedMist: '1000000000';
		};
	}
> = {
	kind: 'strategy-contributor',
	capabilityKey: 'account:alice',
	strategy: {
		name: 'alice',
		address: '0xabc',
		scheme: 'ed25519',
		source: 'real',
		funding: { status: 'funded', balanceMist: null, requestedMist: '1000000000' },
	},
	autoMounted: true,
};

const packageStrategyDecl: StrategyContributorDecl<
	'package-registry',
	{
		readonly kind: 'local';
		readonly name: 'vault';
		readonly packageId: '0x123';
		readonly upgradeCapId: null;
		readonly mvrPlaceholder: '@local/vault';
		readonly sourcePath: 'move/vault';
	}
> = {
	kind: 'strategy-contributor',
	capabilityKey: 'package-registry',
	strategy: {
		kind: 'local',
		name: 'vault',
		packageId: '0x123',
		upgradeCapId: null,
		mvrPlaceholder: '@local/vault',
		sourcePath: 'move/vault',
	},
	autoMounted: true,
};

const accountProjectionDecl: ProjectionDecl = {
	kind: 'projection',
	event: {
		tag: 'account.updated',
		account: {
			key: 'account/alice',
			rowKey: null,
			name: 'alice',
			address: '0xabc',
			scheme: 'ed25519',
			source: 'real',
			funding: { status: 'funded', balanceMist: null, requestedMist: '1000000000' },
			walletVisible: false,
			updatedAt: 1,
		},
		at: 1,
	},
};

const packageProjectionDecl: ProjectionDecl = {
	kind: 'projection',
	event: {
		tag: 'package.updated',
		package: {
			key: 'package/vault',
			rowKey: null,
			name: 'vault',
			kind: 'local',
			packageId: '0x123',
			upgradeCapId: null,
			mvrPlaceholder: '@local/vault',
			sourcePath: 'move/vault',
			updatedAt: 1,
		},
		at: 1,
	},
};

const errorContribAlpha: PluginErrorContribution = {
	_tag: 'PluginErrorContribution',
	errorTags: ['AlphaError'],
	formatter: (value) => `<<alpha ${value._tag}>>`,
};

const errorContribBeta: PluginErrorContribution = {
	_tag: 'PluginErrorContribution',
	errorTags: ['BetaError', 'GammaError'],
};

// -----------------------------------------------------------------------------
// Test plugins — one leaf per capability kind, plus one error-only plugin.
// -----------------------------------------------------------------------------

const pluginSnap = definePlugin({
	id: 'test:snap',
	kind: 'leaf-long-running' as const,
	start: () => Effect.succeed({ v: 'snap' as const }),
	capabilities: [snapDecl] as const,
});

const pluginRoute = definePlugin({
	id: 'test:route',
	kind: 'leaf-long-running' as const,
	start: () => Effect.succeed({ v: 'route' as const }),
	capabilities: [routeDecl] as const,
});

const pluginCodegen = definePlugin({
	id: 'test:codegen',
	kind: 'leaf-long-running' as const,
	start: () => Effect.succeed({ v: 'codegen' as const }),
	capabilities: [codegenDecl] as const,
});

const pluginStrat = definePlugin({
	id: 'test:strat',
	kind: 'leaf-long-running' as const,
	start: () => Effect.succeed({ v: 'strat' as const }),
	capabilities: [strategyDecl] as const,
});

const pluginAccountProjection = definePlugin({
	id: 'account/alice',
	kind: 'leaf-one-shot' as const,
	start: () => Effect.succeed({ v: 'account' as const }),
	capabilities: [accountStrategyDecl, accountProjectionDecl] as const,
});

const pluginPackageProjection = definePlugin({
	id: 'package:vault',
	kind: 'leaf-long-running' as const,
	start: () => Effect.succeed({ v: 'package' as const }),
	capabilities: [packageStrategyDecl, packageProjectionDecl] as const,
});

const pluginComposite = definePlugin({
	id: 'test:composite',
	kind: 'composite' as const,
	composite: { key: 'plug-composite' },
	start: () => Effect.succeed({ v: 'composite' as const }),
	errorContributions: [errorContribAlpha],
});

const pluginErrorOnly = definePlugin({
	id: 'test:errorOnly',
	kind: 'leaf-one-shot' as const,
	start: () => Effect.succeed({ v: 'err' as const }),
	errorContributions: [errorContribBeta],
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('supervisor harvest loop', () => {
	it.effect('exposes pending and acquiring projection before initial acquire completes', () =>
		Effect.gen(function* () {
			const acquireStarted = yield* Deferred.make<void>();
			const releaseAcquire = yield* Deferred.make<void>();
			const acquiringEventSeen = yield* Deferred.make<void>();
			const readyEventSeen = yield* Deferred.make<void>();
			const eventOrder = yield* Ref.make<ReadonlyArray<string>>([]);

			const pluginSlow = definePlugin({
				id: 'test:slow',
				kind: 'leaf-long-running' as const,
				start: () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(acquireStarted, void 0).pipe(Effect.ignore);
						yield* Deferred.await(releaseAcquire);
						return { v: 'slow' as const };
					}),
			});
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSlow],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					const pending = yield* SubscriptionRef.get(state);
					expect(pending.rows.find((r) => r.key === 'test:slow#0')?.status).toBe('pending');
					yield* Effect.forkScoped(
						Effect.gen(function* () {
							while (true) {
								const event = yield* Queue.take(startup.handle.events);
								if (event.tag === 'lifecycle.statusChanged' && event.pluginKey === 'test:slow#0') {
									yield* Ref.update(eventOrder, (current) => [...current, event.to]);
									if (event.to === 'acquiring') {
										yield* Deferred.succeed(acquiringEventSeen, void 0).pipe(Effect.ignore);
									}
									if (event.to === 'ready') {
										yield* Deferred.succeed(readyEventSeen, void 0).pipe(Effect.ignore);
									}
								}
							}
						}),
					);

					const bootFiber = yield* Effect.forkScoped(startup.runInitialAcquire);
					yield* Deferred.await(acquireStarted);
					yield* Deferred.await(acquiringEventSeen);
					const acquiring = yield* SubscriptionRef.get(state);
					expect(acquiring.rows.find((r) => r.key === 'test:slow#0')?.status).toBe('acquiring');
					yield* Deferred.succeed(releaseAcquire, void 0).pipe(Effect.ignore);
					yield* Fiber.join(bootFiber);
					yield* Deferred.await(readyEventSeen);

					const running = yield* SubscriptionRef.get(state);
					expect(running.rows.find((r) => r.key === 'test:slow#0')?.status).toBe('ready');
					expect(running.cycle.phase).toBe('running');
					expect(yield* Ref.get(eventOrder)).toEqual(['acquiring', 'ready']);

					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					for (let i = 0; i < 10; i++) {
						const snapshot = yield* SubscriptionRef.get(state);
						if (snapshot.cycle.phase === 'shutting-down') break;
						yield* Effect.yieldNow;
					}

					const shuttingDown = yield* SubscriptionRef.get(state);
					expect(shuttingDown.cycle.phase).toBe('shutting-down');
				}),
			);
		}),
	);

	it.effect('hard-kill command publishes shutdown escalation and flips shutdown state', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [], options: {} };
			const at = Date.parse('2026-05-21T12:00:00.000Z');

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* Queue.offer(startup.handle.commands, {
						tag: 'shutdown.hardKillRequested',
						signal: 'SIGINT',
						exitCode: 130,
						at,
					});

					const event = yield* Queue.take(startup.handle.events);
					expect(event).toEqual({
						tag: 'shutdown.escalated',
						signal: 'SIGINT',
						exitCode: 130,
						at,
					});
					yield* startup.handle.awaitShutdown;
				}),
			);

			const snap = yield* SubscriptionRef.get(state);
			expect(snap.cycle.phase).toBe('shutting-down');
		}),
	);

	it.effect('graceful shutdown tears down ready rows before awaitShutdown resolves', () =>
		Effect.gen(function* () {
			const pluginShutdown = definePlugin({
				id: 'test:shutdown',
				kind: 'leaf-long-running' as const,
				start: () => Effect.succeed({ v: 'shutdown' as const }),
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginShutdown], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:shutdown#0'));

					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					yield* startup.handle.awaitShutdown;

					const snap = yield* SubscriptionRef.get(state);
					expect(snap.cycle.phase).toBe('shutting-down');
					expect(snap.rows.find((r) => r.key === 'test:shutdown#0')?.status).toBe('stopped');
				}),
			);
		}),
	);

	it.effect('dispatches each CapabilityDecl kind to its OrchestratorSinks slot', () =>
		Effect.gen(function* () {
			const { ref, sinks } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginRoute, pluginCodegen, pluginStrat],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), sinks);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key);
					}
				}),
			);

			const captured = yield* Ref.get(ref);
			// Plugin keys are derived as `<member.id>#<ordinal>` by the
			// dep-graph resolver (see `lifecycle/dep-graph.ts:120`),
			// where `<ordinal>` is the member's position in the stack
			// tuple. Composite plugins use their declared metadata key.
			expect(captured.snapshotable).toEqual([
				{ key: 'test:snap#0', subtree: 'runtime/snap-subtree' },
			]);
			expect(captured.routable).toEqual([{ key: 'test:route#1', endpoint: 'demo-endpoint' }]);
			expect(captured.codegenable).toEqual([{ key: 'test:codegen#2', emitter: 'demo-emitter' }]);
			expect(captured.strategy).toEqual([{ key: 'test:strat#3', capabilityKey: 'demo-strategy' }]);
		}),
	);

	it.effect(
		'projects harvested account registry contributions into SubscribableState.accounts',
		() =>
			Effect.gen(function* () {
				const state = yield* makeProjectionRef();
				const stack: SupervisedStack = {
					_tag: 'Stack',
					members: [pluginAccountProjection],
					options: {},
				};

				yield* Effect.scoped(
					Effect.gen(function* () {
						const startup = yield* startSupervisor(stack, identity, state);
						const pending = yield* SubscriptionRef.get(state);
						expect(pending.accounts).toEqual([
							{
								key: 'account/alice',
								rowKey: 'account/alice#0',
								name: 'alice',
								address: null,
								scheme: null,
								source: null,
								funding: { status: 'pending', balanceMist: null, requestedMist: null },
								walletVisible: false,
								updatedAt: expect.any(Number),
							},
						]);

						yield* startup.runInitialAcquire;
						const ready = yield* SubscriptionRef.get(state);
						expect(ready.accounts).toEqual([
							{
								key: 'account/alice',
								rowKey: 'account/alice#0',
								name: 'alice',
								address: '0xabc',
								scheme: 'ed25519',
								source: 'real',
								funding: {
									status: 'funded',
									balanceMist: null,
									requestedMist: '1000000000',
								},
								walletVisible: false,
								updatedAt: expect.any(Number),
							},
						]);
					}),
				);
			}),
	);

	it.effect(
		'projects harvested package registry contributions into SubscribableState.packages',
		() =>
			Effect.gen(function* () {
				const state = yield* makeProjectionRef();
				const stack: SupervisedStack = {
					_tag: 'Stack',
					members: [pluginPackageProjection],
					options: {},
				};

				yield* Effect.scoped(
					Effect.gen(function* () {
						const startup = yield* startSupervisor(stack, identity, state);
						const pending = yield* SubscriptionRef.get(state);
						expect(pending.packages).toEqual([]);

						yield* startup.runInitialAcquire;
						const ready = yield* SubscriptionRef.get(state);
						expect(ready.packages).toEqual([
							{
								key: 'package/vault',
								rowKey: 'package:vault#0',
								name: 'vault',
								kind: 'local',
								packageId: '0x123',
								upgradeCapId: null,
								mvrPlaceholder: '@local/vault',
								sourcePath: 'move/vault',
								updatedAt: expect.any(Number),
							},
						]);
					}),
				);
			}),
	);

	it.effect('uses plugin metadata for composite keys', () =>
		Effect.gen(function* () {
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginComposite],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key);
					}
				}),
			);

			const snapshot = yield* SubscriptionRef.get(state);
			expect(snapshot.rows.map((row) => row.key)).toEqual(['test:snap#0', 'plug-composite']);
		}),
	);

	it.effect('runs the harvest path for plugins that contribute only errorContributions', () =>
		// The plugin emits NO capability decls — only a
		// `PluginErrorContribution`. The supervisor's harvest must
		// dispatch the error contribution to the substrate's
		// `error-contribution` sink (which folds into the
		// FormatterRegistry); no orchestrator-side callback fires for
		// this kind because `OrchestratorSinks` carries no error slot.
		// We assert the supervisor reached ready WITHOUT calling any
		// capability-side callback — the harvest path completed cleanly.
		Effect.gen(function* () {
			const { ref, sinks } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginErrorOnly],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), sinks);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key);
					}
				}),
			);

			const captured = yield* Ref.get(ref);
			// Zero capability dispatches — only an error contribution.
			expect(captured.snapshotable).toEqual([]);
			expect(captured.routable).toEqual([]);
			expect(captured.codegenable).toEqual([]);
			expect(captured.strategy).toEqual([]);

			// The projection now lists the error-only plugin among rows
			// (the supervisor declares rows for non-inner top-level
			// plugins post-acquire). Pins that the harvest path
			// completed without short-circuiting on the missing
			// capability tuple.
			const snap = yield* SubscriptionRef.get(state);
			const rowKeys = snap.rows.map((r) => r.key);
			expect(rowKeys).toContain('test:errorOnly#0');
		}),
	);

	it.effect('dispatches each plugin exactly once per acquire', () =>
		// Boot a stack with two plugins, each emitting one decl. We assert
		// the orchestrator callback fires exactly once per plugin.
		Effect.gen(function* () {
			const { ref, sinks } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginRoute],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), sinks);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key);
					}
				}),
			);

			const captured = yield* Ref.get(ref);
			expect(captured.snapshotable.length).toBe(1);
			expect(captured.routable.length).toBe(1);
		}),
	);

	it.effect(
		'plugin-author Layer composition adds a custom-kind sink the supervisor harvests through',
		() =>
			// Demonstrates the plugin-author extension path (ARCHITECTURE.md §
			// Plugin-author extension via Layer composition): a custom plugin
			// emits a `CapabilityDecl` whose `kind` literal is not in the
			// substrate's built-in vocabulary. The author composes a Layer
			// that yields `CapabilitySinksService` and calls `registerSink`
			// for that kind, layers it into `pluginContext` alongside the
			// orchestrator-built default. The supervisor must harvest THROUGH
			// the composed registry — i.e., the custom sink's accept body
			// fires for the emitted decl.
			//
			// Before this fix: the supervisor called `Layer.build(
			// layerCapabilitySinksDefault(sinks))` internally and harvested
			// through its OWN instance, ignoring whatever the caller layered
			// in. The plugin author's sink never fired.
			Effect.gen(function* () {
				interface CustomDecl {
					readonly kind: 'plugin-author:custom';
					readonly payload: string;
				}
				const customDecl: CustomDecl = {
					kind: 'plugin-author:custom',
					payload: 'extension-path-fired',
				};
				const pluginCustom = definePlugin({
					id: 'test:custom',
					kind: 'leaf-long-running' as const,
					start: () => Effect.succeed({ v: 'custom' as const }),
					// Cast: the custom decl isn't part of the built-in
					// CapabilityDecl union. The substrate dispatches
					// structurally on `kind`, so the union is the default
					// vocabulary, not a closed surface.
					capabilities: [customDecl] as unknown as readonly never[],
				});

				const captured = yield* Ref.make<ReadonlyArray<string>>([]);

				const customSink: CapabilitySink<'plugin-author:custom', CustomDecl> = {
					kind: 'plugin-author:custom',
					accept: (decl) => Ref.update(captured, (xs) => [...xs, decl.payload]),
				};

				// Plugin-author overlay: yields CapabilitySinksService from
				// the underlying registry Layer, calls registerSink for the
				// custom kind. `Layer.effectDiscard` runs the registration
				// body once per Layer.build; the registerSink call
				// `addFinalizer`s a scope-bound restore (see
				// `capability-sinks/service.ts`) so the override reaps on
				// supervisor shutdown.
				const customOverlay = Layer.effectDiscard(
					Effect.gen(function* () {
						const sinks = yield* CapabilitySinksService;
						yield* sinks.registerSink(customSink);
					}),
				);

				// Compose: base default sinks (empty orchestrator bag for
				// this test) + the plugin-author overlay. This is the layer
				// the caller hands to the supervisor via pluginContext.
				const sinksLayer = customOverlay.pipe(Layer.provideMerge(layerCapabilitySinksDefault({})));

				const stack: SupervisedStack = {
					_tag: 'Stack',
					members: [pluginCustom],
					options: {},
				};
				const state = yield* makeProjectionRef();

				yield* Effect.scoped(
					Effect.gen(function* () {
						// Build the composed sinks layer on the surrounding
						// (test) scope so the service instance survives
						// across into the supervisor.
						const sinksCtx = yield* Layer.build(sinksLayer);
						const sinksService = Context.get(sinksCtx, CapabilitySinksService);
						const pluginContext = Context.empty().pipe(
							Context.add(CapabilitySinksService, sinksService),
						) as Context.Context<never>;

						const handle = yield* supervise(stack, identity, state, pluginContext);
						for (const [key] of handle.graph.nodes) {
							yield* handle.registry.awaitReady(key);
						}
					}),
				);

				const fired = yield* Ref.get(captured);
				expect(fired).toEqual(['extension-path-fired']);
			}),
	);

	it.effect('omitted OrchestratorSinks slots are no-ops without crashing dispatch', () =>
		// The default OrchestratorSinks bag is `{}` — every slot
		// undefined. The substrate's built-in sinks adapt absent slots
		// to `Effect.void`, so the harvest path stays alive even when
		// the orchestrator declines to handle a kind.
		Effect.gen(function* () {
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginRoute, pluginCodegen, pluginStrat],
				options: {},
			};
			const state = yield* makeProjectionRef();

			// Read the projection INSIDE the supervisor's scope —
			// otherwise the scope finalizer transitions every plugin
			// `ready → stopping → stopped` before we inspect, and the
			// status check no longer pins the post-acquire state.
			const readyRows = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key);
					}
					const snap = yield* SubscriptionRef.get(state);
					return snap.rows.filter((r) => r.status === 'ready');
				}),
			);

			expect(readyRows.map((r) => r.key).sort()).toEqual(
				['test:codegen#2', 'test:route#1', 'test:snap#0', 'test:strat#3'].sort(),
			);
		}),
	);

	it.effect('publishes operator-level plugin logs as log.appended events and row log tails', () =>
		Effect.gen(function* () {
			const pluginLog = definePlugin({
				id: 'test:log',
				kind: 'leaf-long-running' as const,
				start: () =>
					Effect.gen(function* () {
						const logger = yield* Logger;
						const current = yield* CurrentPluginKey;
						yield* logger.log(`plugin/${current.key}`, current.key, {
							level: 'warn',
							message: 'plugin emitted warning',
						});
						return { v: 'log' as const };
					}),
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginLog], options: {} };

			const event = yield* Effect.scoped(
				Effect.gen(function* () {
					const loggerContext = yield* Layer.build(layerLogger.pipe(Layer.provide(layerRedactor)));
					const logger = Context.get(loggerContext, Logger);
					const pluginContext = Context.empty().pipe(
						Context.add(Logger, logger),
					) as Context.Context<never>;
					const startup = yield* startSupervisor(stack, identity, state, pluginContext);
					const eventFiber = yield* Effect.forkScoped(
						Effect.gen(function* () {
							while (true) {
								const next = yield* Queue.take(startup.handle.events);
								if (
									next.tag === 'log.appended' &&
									next.pluginKey === 'test:log#0' &&
									next.line === 'plugin emitted warning'
								) {
									return next;
								}
							}
						}),
					);
					yield* startup.runInitialAcquire;
					return yield* Fiber.join(eventFiber);
				}),
			);

			expect(event.level).toBe('warn');
			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'test:log#0');
			expect(row?.logTail.lines).toContain('plugin emitted warning');
			expect(row?.logTail.lines).not.toContain('plugin acquire start');
		}),
	);

	it.effect('acquire failure publishes structured error and leaves a failed row', () =>
		Effect.gen(function* () {
			const pluginFail = definePlugin({
				id: 'test:fail',
				kind: 'leaf-long-running' as const,
				start: () =>
					Effect.fail(new Error('boom from acquire')) as Effect.Effect<
						{ readonly v: 'fail' },
						Error
					>,
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginFail], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* supervise(stack, identity, state);
				}),
			);

			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'test:fail#0');
			expect(row?.status).toBe('failed');
			expect(row?.lastError?.pluginKey).toBe('test:fail#0');
			expect(row?.lastError?.summary).toContain('boom from acquire');
			expect(snap.errors.at(-1)?.pluginKey).toBe('test:fail#0');
			expect(snap.cycle.phase).toBe('running');
		}),
	);

	it.effect('capability factory failure reports a structured error instead of marking ready', () =>
		Effect.gen(function* () {
			const pluginCaps = definePlugin({
				id: 'test:caps',
				kind: 'leaf-long-running' as const,
				start: () => Effect.succeed({ v: 'caps' as const }),
				capabilities: (() => {
					throw new Error('capability boom');
				}) as never,
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginCaps], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* supervise(stack, identity, state);
				}),
			);

			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'test:caps#0');
			expect(row?.status).toBe('failed');
			expect(row?.lastError?.tag).toBe('CapabilityFactoryFailed');
			expect(row?.lastError?.pluginKey).toBe('test:caps#0');
			expect(row?.lastError?.chain.join('\n')).toContain('capability boom');
			expect(snap.cycle.phase).toBe('running');
		}),
	);

	it.effect('capability sink failure reports a structured error instead of crashing', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginRoute], options: {} };
			const sinks: OrchestratorSinks = {
				routable: () => Effect.fail(new Error('route dispatch boom')),
			};

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* supervise(stack, identity, state, Context.empty(), sinks);
				}),
			);

			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'test:route#0');
			expect(row?.status).toBe('failed');
			expect(row?.lastError?.pluginKey).toBe('test:route#0');
			expect(row?.lastError?.chain.join('\n')).toContain('route dispatch boom');
			expect(snap.errors.at(-1)?.pluginKey).toBe('test:route#0');
			expect(snap.cycle.phase).toBe('running');
		}),
	);
});
