// Supervisor post-start dispatch direct tests.
//
// This file pins the wiring contract directly: a minimal stack whose
// plugins emit contributions inline via the typed `ctx` verbs (+ static
// `errorContributions`) is supervised to ready, and we assert each
// buffered contribution reached the matching `ContributionDispatcher`
// method at the supervisor boundary.
//
// Architecture invariants under test:
//   1. The supervisor's post-start replay walks each plugin's ctx buffer
//      (in emit order) AND its `errorContributions` field, routing the
//      former through the closed `ContributionDispatcher` and the latter
//      into the FormatterRegistry.
//   2. Each decl kind dispatches to its matching dispatcher method.
//      Plugins emitting decls of different kinds dispatch differently.
//   3. Dispatch occurs once per plugin after acquire succeeds — no
//      duplicate calls; no calls for plugins that failed acquire.
//   4. The supervisor stays name-blind: it switches on the closed decl
//      discriminant; the dispatcher (built in L3) is the ONE place
//      orchestrator names land.

import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, pluginKey, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	Logger,
	layerLogger,
	makeProjectionRef,
	noopContributionDispatcher,
	startSupervisor,
	supervise,
	type ContributionDispatcher,
	type SupervisedStack,
} from '../../../src/substrate/runtime/index.ts';
import { CurrentPluginKey } from '../../../src/substrate/runtime/current-plugin.ts';
import { definePlugin, type PluginErrorContribution } from '../../../src/substrate/plugin.ts';
import { PluginContext } from '../../../src/substrate/plugin-ctx.ts';
import type { CodegenableDecl } from '../../../src/contracts/codegenable.ts';
import type { ProjectionDecl } from '../../../src/contracts/projection.ts';
import type { RoutableDecl } from '../../../src/contracts/routable.ts';
import type { SnapshotableDecl } from '../../../src/contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../../src/contracts/strategy-contributor.ts';

/** A projection dispatcher matching the production rowKey-stamping body
 *  (`buildProductionContributionDispatcher`): stamps the contributing
 *  plugin key onto an absent `rowKey` then publishes the projection
 *  event so the reducer folds it into `accounts`/`packages`. Other kinds
 *  are no-ops. The strategy-contributor body registers (so a sibling can
 *  `requires`), but these tests only assert the projection reducer
 *  output. */
const projectionDispatcher: ContributionDispatcher = {
	...noopContributionDispatcher,
	projection: (decl, ctx) => {
		const payload = decl.event.payload;
		const payloadWithRowKey =
			payload !== null &&
			typeof payload === 'object' &&
			'rowKey' in payload &&
			(payload as { rowKey: unknown }).rowKey === null
				? { ...payload, rowKey: ctx.pluginKey }
				: payload;
		return ctx.publish({ ...decl.event, payload: payloadWithRowKey });
	},
	strategyContributor: (decl, ctx) =>
		ctx.strategyRegistry.register(decl.capabilityKey, decl.strategy, {
			autoMounted: decl.autoMounted,
			...(decl.priority === undefined ? {} : { priority: decl.priority }),
		}),
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const identity: Identity = {
	app: appName('supervisor-test-app'),
	stack: stackName('main'),
	chain: 'test:local',
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
		const dispatcher: ContributionDispatcher = {
			snapshotable: (decl, ctx) =>
				Ref.update(ref, (c) => ({
					...c,
					snapshotable: [
						...c.snapshotable,
						{ key: String(ctx.pluginKey), subtree: decl.subtrees[0] ?? '' },
					],
				})),
			routable: (decl, ctx) =>
				Ref.update(ref, (c) => ({
					...c,
					routable: [...c.routable, { key: String(ctx.pluginKey), endpoint: decl.endpointName }],
				})),
			codegenable: (decl, ctx) =>
				Ref.update(ref, (c) => ({
					...c,
					codegenable: [
						...c.codegenable,
						{ key: String(ctx.pluginKey), emitter: decl.emitterName },
					],
				})),
			projection: () => Effect.void,
			strategyContributor: (decl, ctx) =>
				Ref.update(ref, (c) => ({
					...c,
					strategy: [
						...c.strategy,
						{ key: String(ctx.pluginKey), capabilityKey: decl.capabilityKey },
					],
				})),
		};
		return { ref, dispatcher };
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
	dispatchId: { serviceKey: 'demo', role: 'app' },
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
			readonly entries: readonly [
				{
					readonly coin: 'SUI';
					readonly fullCoinType: '0x2::sui::SUI';
					readonly amount: '1000000000';
					readonly status: 'funded';
				},
			];
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
		funding: {
			status: 'funded',
			balanceMist: null,
			requestedMist: '1000000000',
			entries: [
				{
					coin: 'SUI',
					fullCoinType: '0x2::sui::SUI',
					amount: '1000000000',
					status: 'funded',
				},
			],
		},
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
		tag: 'projection.updated',
		kind: 'account',
		key: 'account/alice',
		payload: {
			key: 'account/alice',
			rowKey: null,
			name: 'alice',
			address: '0xabc',
			scheme: 'ed25519',
			source: 'real',
			funding: {
				status: 'funded',
				balanceMist: null,
				requestedMist: '1000000000',
				entries: [
					{
						coin: 'SUI',
						fullCoinType: '0x2::sui::SUI',
						amount: '1000000000',
						status: 'funded',
					},
				],
			},
			walletVisible: false,
			updatedAt: 1,
		},
		at: 1,
	},
};

const packageProjectionDecl: ProjectionDecl = {
	kind: 'projection',
	event: {
		tag: 'projection.updated',
		kind: 'package',
		key: 'package/vault',
		payload: {
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
	role: 'service' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
			ctx.snapshotExtra(snapDecl);
			return { v: 'snap' as const };
		}),
});

const pluginRoute = definePlugin({
	id: 'test:route',
	role: 'service' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
			ctx.endpoint(routeDecl);
			return { v: 'route' as const };
		}),
});

const pluginCodegen = definePlugin({
	id: 'test:codegen',
	role: 'service' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
			ctx.codegen(codegenDecl);
			return { v: 'codegen' as const };
		}),
});

const pluginStrat = definePlugin({
	id: 'test:strat',
	role: 'service' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
			ctx.provides(strategyDecl);
			return { v: 'strat' as const };
		}),
});

const pluginAccountProjection = definePlugin({
	id: 'account/alice',
	role: 'task' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
			ctx.provides(accountStrategyDecl);
			ctx.publish(accountProjectionDecl);
			return { v: 'account' as const };
		}),
});

const pluginPackageProjection = definePlugin({
	id: 'package:vault',
	role: 'service' as const,
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
			ctx.provides(packageStrategyDecl);
			ctx.publish(packageProjectionDecl);
			return { v: 'package' as const };
		}),
});

const pluginStableKey = definePlugin({
	id: 'test:stable-key',
	role: 'task' as const,
	section: 'service',
	pluginKey: 'plug-stable-key',
	start: () => Effect.succeed({ v: 'stable-key' as const }),
	errorContributions: [errorContribAlpha],
});

const pluginErrorOnly = definePlugin({
	id: 'test:errorOnly',
	role: 'task' as const,
	section: 'service',
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
				role: 'service' as const,
				section: 'service',
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

	it.effect('starts downstream nodes as soon as their own dependencies are ready', () =>
		Effect.gen(function* () {
			const slowWalrusStarted = yield* Deferred.make<void>();
			const releaseSlowWalrus = yield* Deferred.make<void>();
			const sealStarted = yield* Ref.make(false);

			const root = definePlugin({
				id: 'test:root',
				role: 'task' as const,
				section: 'service',
				start: () => Effect.succeed({ v: 'root' as const }),
			});
			const signer = definePlugin({
				id: 'test:signer',
				role: 'task' as const,
				section: 'service',
				dependsOn: { root },
				start: () => Effect.succeed({ v: 'signer' as const }),
			});
			const slowWalrus = definePlugin({
				id: 'test:walrus',
				role: 'service' as const,
				section: 'service',
				dependsOn: { root },
				start: () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(slowWalrusStarted, void 0).pipe(Effect.ignore);
						yield* Deferred.await(releaseSlowWalrus);
						return { v: 'walrus' as const };
					}),
			});
			const seal = definePlugin({
				id: 'test:seal',
				role: 'service' as const,
				section: 'service',
				dependsOn: { signer },
				start: () =>
					Effect.gen(function* () {
						yield* Ref.set(sealStarted, true);
						return { v: 'seal' as const };
					}),
			});
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [root, signer, slowWalrus, seal],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					const bootFiber = yield* Effect.forkScoped(startup.runInitialAcquire);

					yield* Deferred.await(slowWalrusStarted);
					yield* startup.handle.registry.awaitReady(pluginKey('test:signer#1'));
					for (let i = 0; i < 10; i++) {
						if (yield* Ref.get(sealStarted)) break;
						yield* Effect.yieldNow;
					}

					expect(yield* Ref.get(sealStarted)).toBe(true);
					yield* Deferred.succeed(releaseSlowWalrus, void 0).pipe(Effect.ignore);
					yield* Fiber.join(bootFiber);
					yield* startup.handle.registry.awaitReady(pluginKey('test:seal#3'));
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
				role: 'service' as const,
				section: 'service',
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

	it.effect('runCommand waits for live apply post-acquire work to finish', () =>
		Effect.gen(function* () {
			const callCount = yield* Ref.make(0);
			const applyStarted = yield* Deferred.make<void>();
			const releaseApply = yield* Deferred.make<void>();
			const applyFinished = yield* Ref.make(false);
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						Context.empty(),
						noopContributionDispatcher,
						undefined,
						() =>
							Effect.gen(function* () {
								const call = yield* Ref.updateAndGet(callCount, (n) => n + 1);
								if (call === 1) return [];
								yield* Deferred.succeed(applyStarted, void 0).pipe(Effect.ignore);
								yield* Deferred.await(releaseApply);
								yield* Ref.set(applyFinished, true);
								return [];
							}),
					);
					yield* startup.runInitialAcquire;
					const applyFiber = yield* Effect.forkScoped(
						startup.handle.runCommand({ tag: 'apply.requested' }),
					);

					yield* Deferred.await(applyStarted);
					yield* Effect.yieldNow;
					expect(yield* Ref.get(applyFinished)).toBe(false);
					yield* Deferred.succeed(releaseApply, void 0).pipe(Effect.ignore);
					yield* Fiber.join(applyFiber);
					expect(yield* Ref.get(applyFinished)).toBe(true);
				}),
			);
		}),
	);

	// NOTE: the former "snapshot capture does not block shutdown commands" and
	// "second snapshot keypress is skipped while capture is running" tests are
	// removed. Capture is no longer a forked background task with skip-dedup; it
	// is the lifecycle bounce that runs INLINE in the command loop (gather →
	// graceful-stop → commit → retag → hard-rm + the loop's converge), exactly
	// like `snapshot.restore`. The command loop serializes commands, so a
	// long capture is followed by — not overlapped with — a queued command;
	// double-SIGINT hard-kill remains the escape hatch (covered by the shutdown
	// tests). The stack-restart background task (forked, skip-deduped) is
	// unchanged — see "manual stack restart does not block shutdown commands".

	it.effect('manual stack restart does not block shutdown commands', () =>
		Effect.gen(function* () {
			const restartStarted = yield* Deferred.make<void>();
			const starts = yield* Ref.make(0);
			const finalizers = yield* Ref.make(0);
			const pluginRestarting = definePlugin({
				id: 'test:restarting',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						const run = yield* Ref.updateAndGet(starts, (n) => n + 1);
						yield* Effect.addFinalizer(() => Ref.update(finalizers, (n) => n + 1));
						if (run === 2) {
							yield* Deferred.succeed(restartStarted, void 0).pipe(Effect.ignore);
							yield* Effect.never;
						}
						return { run };
					}),
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginRestarting], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:restarting#0'));

					yield* Queue.offer(startup.handle.commands, { tag: 'stack.restart' });
					yield* Deferred.await(restartStarted);
					yield* Queue.offer(startup.handle.commands, { tag: 'stack.restart' });
					yield* Queue.offer(startup.handle.commands, { tag: 'stack.restart' });
					for (let i = 0; i < 10; i++) {
						yield* Effect.yieldNow;
					}
					expect(yield* Ref.get(starts)).toBe(2);

					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					for (let i = 0; i < 10; i++) {
						const snapshot = yield* SubscriptionRef.get(state);
						if (snapshot.cycle.phase === 'shutting-down') break;
						yield* Effect.yieldNow;
					}

					const snap = yield* SubscriptionRef.get(state);
					expect(snap.cycle.phase).toBe('shutting-down');
					yield* startup.handle.awaitShutdown;
					expect(yield* Ref.get(finalizers)).toBeGreaterThanOrEqual(1);
				}),
			);
		}),
	);


	it.effect('hot restart reacquires with a fresh scope and ready gate', () =>
		Effect.gen(function* () {
			const starts = yield* Ref.make(0);
			const finalizers = yield* Ref.make(0);
			const restartableKey = pluginKey('test:restartable#0');
			const pluginRestartable = definePlugin({
				id: 'test:restartable',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						const run = yield* Ref.updateAndGet(starts, (n) => n + 1);
						yield* Effect.addFinalizer(() => Ref.update(finalizers, (n) => n + 1));
						return { run };
					}),
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginRestartable], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;
					const first = yield* startup.handle.registry.awaitReady(restartableKey);
					expect((first as { readonly run: number }).run).toBe(1);
					expect(yield* Ref.get(finalizers)).toBe(0);

					yield* Queue.offer(startup.handle.commands, {
						tag: 'selective-restart.requested',
						pluginKey: restartableKey,
					});
					while (true) {
						const event = yield* Queue.take(startup.handle.events);
						if (
							event.tag === 'restart.completed' &&
							event.target !== 'stack' &&
							event.target.pluginKey === restartableKey
						) {
							break;
						}
					}

					const second = yield* startup.handle.registry.awaitReady(restartableKey);
					expect((second as { readonly run: number }).run).toBe(2);
					expect(yield* Ref.get(starts)).toBe(2);
					expect(yield* Ref.get(finalizers)).toBe(1);
					const snap = yield* SubscriptionRef.get(state);
					expect(snap.rows.find((row) => row.key === restartableKey)?.status).toBe('ready');
				}),
			);

			expect(yield* Ref.get(finalizers)).toBe(2);
		}),
	);

	it.effect('selective restart of a non-ready (pending) node does not wedge the command loop', () =>
		// Regression: `resetForRestart` used to leave the node's status
		// untouched and the restart path then ran `transition(key,
		// 'pending')`. The transition table only admits `→ pending` from
		// terminal states (`failed` / `stopped` / `done`), so a node that
		// was still `pending` (or `acquiring`) when the restart landed hit
		// `assertTransition('pending', 'pending')` — an off-table move
		// surfaced as `Effect.die`. Defects are NOT caught by the
		// `Effect.catch(() => …)` wrappers on the restart path or in the
		// command loop, so the defect killed the command-loop fiber and
		// the supervisor wedged (no further commands — including graceful
		// shutdown — were processed).
		//
		// We reproduce the off-table state deterministically by NOT
		// running the initial acquire: every entry is built `pending` by
		// `startSupervisor`, and with no acquire fiber the target node
		// stays `pending`. Firing `selective-restart.requested` then
		// drives `resetForRestart` from `pending`. The fix makes
		// `resetForRestart` set the status to `pending` authoritatively
		// (no `transition` hop), so the subsequent acquire performs a
		// clean `pending → acquiring`. We assert the restart RUNS the
		// node's `start` exactly once, reaches `ready`, and that a later
		// `shutdown.requested` is still processed (the loop survived).
		Effect.gen(function* () {
			const starts = yield* Ref.make(0);
			const restartableKey = pluginKey('test:restart-pending#0');
			const pluginRestartable = definePlugin({
				id: 'test:restart-pending',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						yield* Ref.update(starts, (n) => n + 1);
						return { v: 'restart-pending' as const };
					}),
			});
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginRestartable], options: {} };

			yield* Effect.scoped(
				Effect.gen(function* () {
					// NB: deliberately DO NOT call `startup.runInitialAcquire`.
					// The command loop is forked by `startSupervisor`
					// regardless, and the node stays `pending`.
					const startup = yield* startSupervisor(stack, identity, state);

					const pending = yield* SubscriptionRef.get(state);
					expect(pending.rows.find((r) => r.key === restartableKey)?.status).toBe('pending');
					expect(yield* Ref.get(starts)).toBe(0);

					yield* Queue.offer(startup.handle.commands, {
						tag: 'selective-restart.requested',
						pluginKey: restartableKey,
					});

					// The restart must complete — pre-fix the command-loop
					// fiber dies on the defect and this event never arrives,
					// so the test hangs (times out) rather than passing.
					while (true) {
						const event = yield* Queue.take(startup.handle.events);
						if (
							event.tag === 'restart.completed' &&
							event.target !== 'stack' &&
							event.target.pluginKey === restartableKey
						) {
							break;
						}
					}

					const acquired = yield* startup.handle.registry.awaitReady(restartableKey);
					expect((acquired as { readonly v: string }).v).toBe('restart-pending');
					expect(yield* Ref.get(starts)).toBe(1);
					const snap = yield* SubscriptionRef.get(state);
					expect(snap.rows.find((r) => r.key === restartableKey)?.status).toBe('ready');

					// The command loop survived the restart: a subsequent
					// command is still processed end-to-end.
					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					yield* startup.handle.awaitShutdown;
					const shuttingDown = yield* SubscriptionRef.get(state);
					expect(shuttingDown.cycle.phase).toBe('shutting-down');
				}),
			);
		}),
	);

	it.effect('dispatches each contribution kind to its ContributionDispatcher method', () =>
		Effect.gen(function* () {
			const { ref, dispatcher } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginRoute, pluginCodegen, pluginStrat],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), dispatcher);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key);
					}
				}),
			);

			const captured = yield* Ref.get(ref);
			// Plugin keys are derived as `<member.id>#<ordinal>` by the
			// dep-graph resolver (see `lifecycle/dep-graph.ts:120`),
			// where `<ordinal>` is the member's position in the stack
			// tuple. Plugins may use their declared metadata key.
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
						const startup = yield* startSupervisor(
							stack,
							identity,
							state,
							Context.empty(),
							projectionDispatcher,
						);
						const pending = yield* SubscriptionRef.get(state);
						expect(pending.accounts).toEqual([
							{
								key: 'account/alice',
								rowKey: 'account/alice#0',
								name: 'alice',
								address: null,
								scheme: null,
								source: null,
								funding: { status: 'pending', balanceMist: null, requestedMist: null, entries: [] },
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
									entries: [
										{
											coin: 'SUI',
											fullCoinType: '0x2::sui::SUI',
											amount: '1000000000',
											status: 'funded',
										},
									],
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
						const startup = yield* startSupervisor(
							stack,
							identity,
							state,
							Context.empty(),
							projectionDispatcher,
						);
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

	it.effect('uses plugin metadata for stable plugin keys', () =>
		Effect.gen(function* () {
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginStableKey],
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
			expect(snapshot.rows.map((row) => row.key)).toEqual(['test:snap#0', 'plug-stable-key']);
		}),
	);

	it.effect('runs the dispatch path for plugins that contribute only errorContributions', () =>
		// The plugin emits NO ctx contributions — only a
		// `PluginErrorContribution`. The supervisor feeds the error
		// contribution directly into the FormatterRegistry; no dispatcher
		// method fires (the buffer is empty). We assert the supervisor
		// reached ready WITHOUT calling any dispatcher method — the
		// dispatch path completed cleanly.
		Effect.gen(function* () {
			const { ref, dispatcher } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginErrorOnly],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), dispatcher);
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
			const { ref, dispatcher } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [pluginSnap, pluginRoute],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), dispatcher);
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

	it.effect('the no-op dispatcher leaves every plugin ready without crashing dispatch', () =>
		// The default `ContributionDispatcher` is the no-op dispatcher
		// (bare smoke-test path). Buffered contributions simply have
		// nowhere to go, so the post-start dispatch stays alive and every
		// plugin reaches `ready`.
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
				role: 'service' as const,
				section: 'service',
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
					const loggerContext = yield* Layer.build(layerLogger);
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
				role: 'service' as const,
				section: 'service',
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

	it.effect(
		'upstream acquire failure marks dependents failed without duplicating top-level errors',
		() =>
			Effect.gen(function* () {
				const pluginFail = definePlugin({
					id: 'test:root-fail',
					role: 'service' as const,
					section: 'service',
					start: () =>
						Effect.fail(new Error('root acquire failed')) as Effect.Effect<
							{ readonly v: 'fail' },
							Error
						>,
				});
				const pluginDependent = definePlugin({
					id: 'test:dependent',
					role: 'service' as const,
					section: 'service',
					dependsOn: pluginFail,
					start: () => Effect.succeed({ v: 'dependent' as const }),
				});
				const state = yield* makeProjectionRef();
				const stack: SupervisedStack = {
					_tag: 'Stack',
					members: [pluginFail, pluginDependent],
					options: {},
				};

				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* supervise(stack, identity, state);
					}),
				);

				const snap = yield* SubscriptionRef.get(state);
				const rootRow = snap.rows.find((r) => r.key === 'test:root-fail#0');
				const dependentRow = snap.rows.find((r) => r.key === 'test:dependent#1');
				expect(rootRow?.status).toBe('failed');
				expect(rootRow?.lastError?.summary).toContain('root acquire failed');
				expect(dependentRow?.status).toBe('failed');
				expect(dependentRow?.lastError).toBeNull();
				expect(snap.errors.map((error) => error.pluginKey)).toEqual(['test:root-fail#0']);
			}),
	);

	it.effect('contribution-dispatch failure reports a structured event instead of crashing', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [pluginRoute], options: {} };
			// A dispatcher whose `routable` body REJECTS — the
			// orchestrator-fault path.
			const failingDispatcher: ContributionDispatcher = {
				...noopContributionDispatcher,
				routable: () => Effect.fail(new Error('route dispatch boom')),
			};

			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* supervise(stack, identity, state, Context.empty(), failingDispatcher);
				}),
			);

			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'test:route#0');
			// Dispatch-body failure is orchestrator-fault, NOT plugin-fault
			// (backlog #39): the plugin's acquire ran cleanly, the dispatch
			// body that received the contribution failed. Plugin status stays
			// ready; the row's lastError carries no entry attributed to this
			// plugin. `supervise(...)` runs to shutdown, so the plugin's
			// post-supervise status is `'stopped'` (clean lifecycle exit).
			expect(row?.status).toBe('stopped');
			expect(row?.lastError ?? undefined).toBeUndefined();
			// The failure surfaces via the orchestrator-event path —
			// `engine.orchestrator.dispatchFailed` (covered by the dedicated
			// regression at test/substrate/runtime/supervisor-contribution-sink-fail.test.ts).
			expect(snap.cycle.phase).toBe('running');
		}),
	);
});
