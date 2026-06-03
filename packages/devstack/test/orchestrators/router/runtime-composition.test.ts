import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context, Effect, Layer, Ref, Stream, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { definePlugin } from '../../../src/api/define-plugin.ts';
import type { RoutableDecl } from '../../../src/contracts/routable.ts';
import type { PluginCtx } from '../../../src/substrate/plugin-ctx.ts';
import {
	buildProductionContributionDispatcher,
	buildProductionPostAcquireHook,
	endpointEventFromRoutable,
	layerManifestEndpointRegistry,
	manifestEndpointEntryFromRoutable,
	ManifestEndpointRegistryService,
	productionRouterProfile,
} from '../../../src/orchestrators/runtime-composition.ts';
import {
	RouterService,
	resolveDockerContextId,
	type BootReport,
	type EndpointUrl,
	type ResolvedRoute,
	type RouterServiceShape,
} from '../../../src/orchestrators/router/index.ts';
import {
	SnapshotOrchestratorService,
	type SnapshotOrchestrator,
} from '../../../src/orchestrators/snapshot/index.ts';
import {
	CodegenOrchestratorService,
	type CodegenOrchestrator,
} from '../../../src/orchestrators/codegen/service.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../../src/orchestrators/codegen/paths.ts';
import {
	MoveCodegenService,
	MoveSummaryRunnerService,
} from '../../../src/orchestrators/codegen/bindings.ts';
import {
	appName,
	chainId,
	endpointKey,
	pluginKey,
	stackName,
} from '../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../src/substrate/events.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	supervise,
	type ContributionDispatchContext,
} from '../../../src/substrate/runtime/index.ts';
import type { StrategyRegistry } from '../../../src/contracts/strategy-contributor.ts';
import { buildSubstrateLayers } from '../../../src/orchestrators/run.ts';
import { makeProjectionRef, updateRef } from '../../../src/substrate/runtime/projection/index.ts';

const bootReport: BootReport = {
	decision: 'opt-out',
	containerId: null,
	networkId: null,
	imageMatches: true,
};

const endpoint: EndpointUrl = {
	endpointName: 'wallet-app',
	hostname: 'wallet.demo.localhost',
	entrypointPort: 6173,
	url: 'http://wallet.demo.localhost:6173',
	wireProtocol: 'http',
};

const routable: RoutableDecl = {
	kind: 'routable',
	endpointName: 'wallet-app',
	dispatchId: { serviceKey: 'wallet', role: 'api' },
	upstream: { type: 'host-loopback', port: 49152 },
	cors: true,
	wireProtocol: 'http',
};

const identity: Identity = {
	app: appName('router-runtime-composition'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

const routablePlugin = definePlugin({
	id: 'test/routable',
	role: 'service',
	section: 'service',
	start: (_deps: unknown, ctx: PluginCtx) =>
		Effect.sync(() => {
			ctx.endpoint(routable);
			return { ready: true } as const;
		}),
});

/** Minimal strategy-registry stub for a `ContributionDispatchContext` —
 *  the routable dispatch body never touches it. */
const stubStrategyRegistry: StrategyRegistry = {
	get: () => Effect.die('unused strategy get'),
	list: () => Effect.succeed([]),
	register: () => Effect.void,
};

const operationalEndpointPlugin = definePlugin({
	id: 'test/remote-rpc',
	role: 'service',
	section: 'service',
	start: () =>
		Effect.succeed({
			rpcUrl: 'https://rpc.example.invalid',
		} as const),
});

const snapshotLayer = Layer.succeed(SnapshotOrchestratorService)({
	registerParticipant: () => Effect.void,
	capture: () => Effect.die('unused snapshot capture'),
	restore: () => Effect.die('unused snapshot restore'),
	list: Effect.die('unused snapshot list'),
	delete: () => Effect.die('unused snapshot delete'),
	wipe: () => Effect.die('unused snapshot wipe'),
	wipePlan: () => Effect.die('unused snapshot wipePlan'),
	prune: () => Effect.die('unused snapshot prune'),
	recoverPendingRestore: Effect.die('unused snapshot recoverPendingRestore'),
} satisfies SnapshotOrchestrator);

const codegenLayer = Layer.succeed(CodegenOrchestratorService)({
	registerContribution: () => Effect.void,
	runCycle: () =>
		Effect.succeed({
			filesWritten: [],
			filesUnchanged: [],
			filesChmod: [],
			bindings: null,
		}),
} satisfies CodegenOrchestrator);

const routerLayer = Layer.effect(
	RouterService,
	Effect.gen(function* () {
		const applied = yield* SubscriptionRef.make<ReadonlyArray<ResolvedRoute>>([]);
		return {
			boot: () => Effect.succeed(bootReport),
			contributeRoute: () => Effect.succeed(endpoint),
			applied,
		} satisfies RouterServiceShape;
	}),
);

const sinkTestLayer = Layer.mergeAll(
	snapshotLayer,
	codegenLayer,
	routerLayer,
	layerManifestEndpointRegistry,
);

describe('productionRouterProfile', () => {
	it('is profile-wide and does not vary with runtime roots', () => {
		const runtimeRootA = '/tmp/devstack-runtime-a';
		const runtimeRootB = '/tmp/devstack-runtime-b';
		const opts = { env: { DOCKER_CONTEXT: 'test-context', DOCKER_HOST: undefined } };
		const profileA = productionRouterProfile(opts);
		const profileB = productionRouterProfile(opts);

		expect(profileA).toEqual(profileB);
		expect(profileA.dispatchDir).toContain(`${profileA.id}/dispatch`);
		expect(profileA.dispatchDir).not.toContain('/tmp/devstack-router');
		expect(profileA.dispatchDir).not.toContain(runtimeRootA);
		expect(profileA.dispatchDir).not.toContain(runtimeRootB);
		expect(profileA.containerName).toContain('devstack-router-');
		expect(profileA.networkName).toContain('devstack-router-');
	});

	it('prefers stable context identity over daemon identity when docker exposes both', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-router-profile-'));
		try {
			const bin = join(dir, 'docker');
			writeFileSync(
				bin,
				[
					'#!/bin/sh',
					'if [ "$1" = "info" ]; then printf "daemon-abc123\\n"; exit 0; fi',
					'if [ "$1" = "context" ]; then printf "context-name\\n"; exit 0; fi',
					'exit 1',
					'',
				].join('\n'),
			);
			chmodSync(bin, 0o755);

			expect(
				resolveDockerContextId(
					{ bin },
					{ DOCKER_CONTEXT: 'context-name', DOCKER_HOST: 'tcp://docker.example:2375' },
				),
			).toBe('context:context-name|host:tcp://docker.example:2375');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('uses Docker config currentContext when the CLI context probe is unavailable', () => {
		const dir = mkdtempSync(join(tmpdir(), 'devstack-router-profile-config-'));
		try {
			const bin = join(dir, 'docker');
			const configDir = join(dir, 'docker-config');
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, 'config.json'),
				JSON.stringify({ currentContext: 'desktop-linux' }),
			);
			writeFileSync(
				bin,
				[
					'#!/bin/sh',
					'if [ "$1" = "info" ]; then printf "daemon-abc123\\n"; exit 0; fi',
					'exit 1',
					'',
				].join('\n'),
			);
			chmodSync(bin, 0o755);

			expect(
				resolveDockerContextId(
					{ bin },
					{ DOCKER_CONFIG: configDir, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined },
				),
			).toBe('context:desktop-linux|host:default');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('buildProductionContributionDispatcher', () => {
	it('maps routable deliveries to endpoint.registered events', () => {
		expect(endpointEventFromRoutable(pluginKey('wallet#0'), endpoint, 1234)).toEqual({
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey('wallet#0:wallet-app'),
				pluginKey: pluginKey('wallet#0'),
				name: 'wallet-app',
				url: 'http://wallet.demo.localhost:6173',
				displayUrl: null,
				wireProtocol: 'http',
				registeredAt: 1234,
			},
		});
	});

	it.effect(
		'production routable dispatch publishes endpoint events through the dispatch context',
		() =>
			Effect.gen(function* () {
				const state = yield* makeProjectionRef();
				const observed = yield* Ref.make<ReadonlyArray<EngineEvent>>([]);
				const manifestEndpoints = yield* ManifestEndpointRegistryService;
				const dispatcher = yield* buildProductionContributionDispatcher();
				const dispatchCtx: ContributionDispatchContext = {
					pluginKey: pluginKey('wallet#0'),
					publish: (event) =>
						updateRef(state, event).pipe(
							Effect.andThen(Ref.update(observed, (events) => [...events, event])),
						),
					strategyRegistry: stubStrategyRegistry,
				};

				const entries = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* dispatcher.routable(routable, dispatchCtx);
						return yield* manifestEndpoints.entries;
					}),
				);

				const events = yield* Ref.get(observed);
				expect(events).toHaveLength(1);
				const event = events[0];
				expect(event?.tag).toBe('endpoint.registered');
				if (event?.tag !== 'endpoint.registered') {
					return yield* Effect.die('expected endpoint.registered event');
				}
				expect(event).toMatchObject({
					tag: 'endpoint.registered',
					endpoint: {
						endpointKey: endpointKey('wallet#0:wallet-app'),
						pluginKey: pluginKey('wallet#0'),
						name: 'wallet-app',
						url: 'http://wallet.demo.localhost:6173',
						displayUrl: null,
						wireProtocol: 'http',
					},
				});

				const snapshot = yield* SubscriptionRef.get(state);
				expect(snapshot.endpoints).toEqual([event.endpoint]);
				expect(entries).toEqual([
					manifestEndpointEntryFromRoutable(pluginKey('wallet#0'), endpoint),
				]);
			}).pipe(Effect.provide(sinkTestLayer)),
	);

	it.effect('supervisor emits production endpoint events on the ordered event hub', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const dispatcher = yield* buildProductionContributionDispatcher();

			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(
						{ _tag: 'Stack', members: [routablePlugin], options: {} },
						identity,
						state,
						Context.empty(),
						dispatcher,
					);
					const events = yield* Stream.fromQueue(handle.events).pipe(
						Stream.filter(
							(
								event,
							): event is Extract<
								EngineEvent,
								{ readonly tag: 'lifecycle.statusChanged' | 'endpoint.registered' }
							> => event.tag === 'lifecycle.statusChanged' || event.tag === 'endpoint.registered',
						),
						Stream.take(3),
						Stream.runCollect,
					);
					const snapshot = yield* SubscriptionRef.get(state);
					return { events: [...events], snapshot };
				}),
			);

			expect(result.events.map((event) => event.tag)).toEqual([
				'lifecycle.statusChanged',
				'endpoint.registered',
				'lifecycle.statusChanged',
			]);
			const endpointEvent = result.events[1];
			expect(endpointEvent?.tag).toBe('endpoint.registered');
			if (endpointEvent?.tag !== 'endpoint.registered') {
				return yield* Effect.die('expected endpoint.registered event');
			}
			expect(endpointEvent.endpoint).toMatchObject({
				endpointKey: endpointKey('test/routable#0:wallet-app'),
				pluginKey: pluginKey('test/routable#0'),
				name: 'wallet-app',
				url: 'http://wallet.demo.localhost:6173',
				displayUrl: null,
				wireProtocol: 'http',
			});
			expect(result.snapshot.endpoints).toEqual([endpointEvent.endpoint]);
		}).pipe(Effect.provide(sinkTestLayer)),
	);

	it.effect('production post-acquire hook writes registered routable endpoints to manifest', () =>
		Effect.gen(function* () {
			const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-composition-manifest-'));
			const layer = Layer.mergeAll(
				sinkTestLayer,
				layerCodegenPaths.pipe(
					Layer.provideMerge(
						layerCodegenRoot({
							outputDir: join(runtimeRoot, 'generated'),
							stackSubdir: null,
							extrasDir: join(runtimeRoot, 'generated-extras'),
						}),
					),
				),
				Layer.succeed(MoveSummaryRunnerService)({
					runSummary: () => Effect.die('unused Move summary'),
				}),
				Layer.succeed(MoveCodegenService)({
					generate: () => Effect.die('unused Move codegen'),
				}),
			).pipe(Layer.provideMerge(buildSubstrateLayers(identity, runtimeRoot)));

			try {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const state = yield* makeProjectionRef();
						const dispatcher = yield* buildProductionContributionDispatcher();
						const hook = yield* buildProductionPostAcquireHook();
						yield* supervise(
							{ _tag: 'Stack', members: [routablePlugin], options: {} },
							identity,
							state,
							Context.empty(),
							dispatcher,
							undefined,
							hook,
						);
					}),
				).pipe(Effect.provide(layer));

				const manifest = JSON.parse(
					readFileSync(join(runtimeRoot, 'stacks', 'main', 'manifest.json'), 'utf8'),
				) as {
					readonly endpoints: Record<string, unknown>;
				};
				expect(manifest.endpoints).toEqual({
					'test/routable#0:wallet-app': {
						endpointKey: 'test/routable#0:wallet-app',
						name: 'wallet-app',
						url: 'http://wallet.demo.localhost:6173',
						displayUrl: null,
						wireProtocol: 'http',
						pluginKey: 'test/routable#0',
					},
				});
			} finally {
				rmSync(runtimeRoot, { recursive: true, force: true });
			}
		}),
	);

	it.effect(
		'production post-acquire hook writes non-routable operational endpoints to manifest',
		() =>
			Effect.gen(function* () {
				const runtimeRoot = mkdtempSync(
					join(tmpdir(), 'runtime-composition-operational-manifest-'),
				);
				const layer = Layer.mergeAll(
					sinkTestLayer,
					layerCodegenPaths.pipe(
						Layer.provideMerge(
							layerCodegenRoot({
								outputDir: join(runtimeRoot, 'generated'),
								stackSubdir: null,
								extrasDir: join(runtimeRoot, 'generated-extras'),
							}),
						),
					),
					Layer.succeed(MoveSummaryRunnerService)({
						runSummary: () => Effect.die('unused Move summary'),
					}),
					Layer.succeed(MoveCodegenService)({
						generate: () => Effect.die('unused Move codegen'),
					}),
				).pipe(Layer.provideMerge(buildSubstrateLayers(identity, runtimeRoot)));

				try {
					yield* Effect.scoped(
						Effect.gen(function* () {
							const state = yield* makeProjectionRef();
							const dispatcher = yield* buildProductionContributionDispatcher();
							const hook = yield* buildProductionPostAcquireHook();
							yield* supervise(
								{ _tag: 'Stack', members: [operationalEndpointPlugin], options: {} },
								identity,
								state,
								Context.empty(),
								dispatcher,
								undefined,
								hook,
							);
						}),
					).pipe(Effect.provide(layer));

					const manifest = JSON.parse(
						readFileSync(join(runtimeRoot, 'stacks', 'main', 'manifest.json'), 'utf8'),
					) as {
						readonly endpoints: Record<string, unknown>;
					};
					expect(manifest.endpoints).toEqual({
						'test/remote-rpc#0:rpcUrl': {
							endpointKey: 'test/remote-rpc#0:rpcUrl',
							name: 'rpc',
							url: 'https://rpc.example.invalid',
							displayUrl: null,
							wireProtocol: 'http',
							pluginKey: 'test/remote-rpc#0',
						},
					});
				} finally {
					rmSync(runtimeRoot, { recursive: true, force: true });
				}
			}),
	);
});
