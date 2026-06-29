import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context, Effect, Layer, Ref, Stream, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { definePlugin } from '../../src/api/define-plugin.ts';
import type { RoutableDecl } from '../../src/contracts/routable.ts';
import { PluginContext } from '../../src/substrate/plugin-ctx.ts';
import {
	buildProductionContributionDispatcher,
	buildProductionPostAcquireHook,
	endpointSinksFromRoute,
	layerManifestEndpointRegistry,
	ManifestEndpointRegistryService,
	productionRouterProfile,
	resolveProductionCodegenOptions,
} from '../../src/orchestrators/boot.ts';
import {
	RouterService,
	resolveDockerContextId,
	type BootReport,
	type ResolvedRoute,
	type RouterServiceShape,
} from '../../src/orchestrators/router/index.ts';
import {
	SnapshotOrchestratorService,
	type SnapshotOrchestrator,
} from '../../src/orchestrators/snapshot/index.ts';
import {
	CodegenOrchestratorService,
	type CodegenOrchestrator,
} from '../../src/orchestrators/codegen/service.ts';
import type { PluginRegistry, ResolvedGraph } from '../../src/substrate/runtime/lifecycle/index.ts';
import type { SupervisorPostAcquireContext } from '../../src/substrate/runtime/supervisor/index.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../src/orchestrators/codegen/paths.ts';
import {
	MoveCodegenService,
	MoveSummaryRunnerService,
} from '../../src/orchestrators/codegen/bindings.ts';
import { appName, endpointKey, pluginKey, stackName } from '../../src/substrate/brand.ts';
import type { EngineEvent } from '../../src/substrate/events.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import { supervise, type ContributionDispatchContext } from '../../src/substrate/runtime/index.ts';
import type { StrategyRegistry } from '../../src/contracts/strategy-contributor.ts';
import { buildSubstrateLayers } from '../../src/orchestrators/boot.ts';
import type { Codegenable } from '../../src/orchestrators/codegen/service.ts';
import { makeProjectionRef } from '../../src/substrate/runtime/projection/state-ref.ts';
import { updateRef } from '../../src/substrate/runtime/projection/update.ts';

const bootReport: BootReport = {
	decision: 'opt-out',
	containerId: null,
	networkId: null,
	imageMatches: true,
};

// The router-resolved route the (stubbed) `contributeRoute` returns. The
// boot adapter (`endpointSinksFromRoute`) recovers `endpointName` from
// the decl and discards the router-only fields (dispatchFileId/cors/
// upstreamUrl/entrypointName) from the manifest/projection field-set
// while carrying the full `route` through verbatim for the router sink.
const resolvedRoute: ResolvedRoute = {
	dispatchFileId: 'wallet-api-abc123',
	hostname: 'wallet.demo.localhost',
	entrypointName: 'web',
	entrypointPort: 6173,
	upstreamUrl: 'http://127.0.0.1:49152',
	cors: true,
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

// A TCP route pair — proves the `tcp://127.0.0.1:port` derivation moved
// byte-exactly into the adapter (distinct from the http `hostname:port`
// form) and that the manifest entry + projection event stay in lockstep.
const tcpResolvedRoute: ResolvedRoute = {
	dispatchFileId: 'pg-db-def456',
	hostname: 'pg.demo.localhost',
	entrypointName: 'postgres',
	entrypointPort: 55432,
	upstreamUrl: 'tcp://127.0.0.1:49153',
	cors: false,
	wireProtocol: 'tcp',
};

const tcpRoutable: RoutableDecl = {
	kind: 'routable',
	endpointName: 'pg',
	dispatchId: { serviceKey: 'pg', role: 'db' },
	upstream: { type: 'host-loopback', port: 49153 },
	wireProtocol: 'tcp',
};

const httpsResolvedRoute: ResolvedRoute = {
	dispatchFileId: 'walrus-node-abc789',
	hostname: 'walrus-node-0.demo.localhost',
	entrypointName: 'walrus-node-0',
	entrypointPort: 9185,
	upstreamUrl: 'https://172.20.0.5:9185',
	cors: true,
	wireProtocol: 'https',
};

const httpsRoutable: RoutableDecl = {
	kind: 'routable',
	endpointName: 'walrus-node-0',
	dispatchId: { serviceKey: 'walrus', role: 'walrus-node-0' },
	upstream: { type: 'container', containerName: 'walrus-node-0', containerPort: 9185 },
	cors: true,
	wireProtocol: 'https',
};

const identity: Identity = {
	app: appName('router-runtime-composition'),
	stack: stackName('main'),
	network: 'local',
};

const routablePlugin = definePlugin({
	id: 'test/routable',
	role: 'service',
	section: 'service',
	start: () =>
		Effect.gen(function* () {
			const ctx = yield* PluginContext;
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
} satisfies SnapshotOrchestrator);

const codegenLayer = Layer.succeed(CodegenOrchestratorService)({
	registerContribution: () => Effect.void,
	assembleDeployment: (network) =>
		Effect.succeed({
			defaultNetwork: network,
			networks: {
				[network]: {
					network,
					rpc: '',
					local: true,
					packages: {},
					mvrOverrides: { packages: {}, types: {} },
				},
			},
			accounts: {},
		}),
	emitBindings: () =>
		Effect.succeed({ filesWritten: [], filesUnchanged: [], filesChmod: [], bindings: null }),
} satisfies CodegenOrchestrator);

const routerLayer = Layer.effect(
	RouterService,
	Effect.gen(function* () {
		const applied = yield* SubscriptionRef.make<ReadonlyArray<ResolvedRoute>>([]);
		return {
			boot: () => Effect.succeed(bootReport),
			contributeRoute: () => Effect.succeed(resolvedRoute),
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

describe('endpointSinksFromRoute', () => {
	// Pins the unified adapter: ONE `ResolvedRoute` → ALL THREE sink-feeds
	// at once — the router's own `route` (carried verbatim), the manifest
	// entry (EndpointEntry), AND the projection event (endpoint.registered)
	// — for both an http route (`http://hostname:port`) and a tcp route
	// (`tcp://127.0.0.1:port`). The byte-exact url-derivation now lives
	// here (it moved out of the router's deleted `endpointFromResolvedRoute`);
	// if the forms ever drift, all three sinks drift together — this guards
	// against that.
	it('derives the http route + manifest entry + endpoint event from one ResolvedRoute', () => {
		const { route, event, manifestEntry } = endpointSinksFromRoute(
			routable,
			resolvedRoute,
			pluginKey('wallet#0'),
			1234,
		);
		// Router sink: the source-of-truth ResolvedRoute is carried through
		// verbatim (it is what the router wrote + published onto `applied`).
		expect(route).toBe(resolvedRoute);
		expect(event).toEqual({
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
		expect(manifestEntry).toEqual({
			endpointKey: 'wallet#0:wallet-app',
			pluginKey: 'wallet#0',
			name: 'wallet-app',
			url: 'http://wallet.demo.localhost:6173',
			displayUrl: null,
			wireProtocol: 'http',
		});
		// All three sinks share the same url + name + wireProtocol — they cannot diverge.
		expect(event.endpoint.url).toBe(manifestEntry.url);
		expect(event.endpoint.name).toBe(manifestEntry.name);
		expect(event.endpoint.wireProtocol).toBe(manifestEntry.wireProtocol);
		expect(`http://${route.hostname}:${route.entrypointPort}`).toBe(manifestEntry.url);
	});

	it('derives the tcp route + manifest entry + endpoint event from one ResolvedRoute', () => {
		const { route, event, manifestEntry } = endpointSinksFromRoute(
			tcpRoutable,
			tcpResolvedRoute,
			pluginKey('pg#0'),
			5678,
		);
		expect(route).toBe(tcpResolvedRoute);
		expect(event).toEqual({
			tag: 'endpoint.registered',
			endpoint: {
				endpointKey: endpointKey('pg#0:pg'),
				pluginKey: pluginKey('pg#0'),
				name: 'pg',
				// tcp form is `tcp://127.0.0.1:<entrypointPort>` — NOT the
				// hostname-bearing http form. This is the byte-exact branch.
				url: 'tcp://127.0.0.1:55432',
				displayUrl: null,
				wireProtocol: 'tcp',
				registeredAt: 5678,
			},
		});
		expect(manifestEntry).toEqual({
			endpointKey: 'pg#0:pg',
			pluginKey: 'pg#0',
			name: 'pg',
			url: 'tcp://127.0.0.1:55432',
			displayUrl: null,
			wireProtocol: 'tcp',
		});
		expect(event.endpoint.url).toBe(manifestEntry.url);
		// tcp route carries the loopback form, NOT route.hostname.
		expect(`tcp://127.0.0.1:${route.entrypointPort}`).toBe(manifestEntry.url);
	});

	it('keeps https upstream routes public as http endpoints', () => {
		const { route, event, manifestEntry } = endpointSinksFromRoute(
			httpsRoutable,
			httpsResolvedRoute,
			pluginKey('walrus#0'),
			9012,
		);
		expect(route).toBe(httpsResolvedRoute);
		expect(event.endpoint).toEqual({
			endpointKey: endpointKey('walrus#0:walrus-node-0'),
			pluginKey: pluginKey('walrus#0'),
			name: 'walrus-node-0',
			url: 'http://walrus-node-0.demo.localhost:9185',
			displayUrl: null,
			wireProtocol: 'http',
			registeredAt: 9012,
		});
		expect(manifestEntry).toEqual({
			endpointKey: 'walrus#0:walrus-node-0',
			pluginKey: 'walrus#0',
			name: 'walrus-node-0',
			url: 'http://walrus-node-0.demo.localhost:9185',
			displayUrl: null,
			wireProtocol: 'http',
		});
	});
});

describe('buildProductionContributionDispatcher', () => {
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
				// The dispatcher must register the SAME manifest entry the adapter
				// derives from the resolved route the router stub returned.
				expect(entries).toEqual([
					endpointSinksFromRoute(routable, resolvedRoute, pluginKey('wallet#0')).manifestEntry,
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

describe('resolveProductionCodegenOptions', () => {
	it('passes includePhantomTypeParameters through verbatim', () => {
		const resolved = resolveProductionCodegenOptions({
			appRoot: '/app',
			codegen: { includePhantomTypeParameters: true },
		});
		expect(resolved.includePhantomTypeParameters).toBe(true);
		expect(resolved.appRoot).toBe('/app');
	});

	it('leaves includePhantomTypeParameters unset when the config omits it', () => {
		const resolved = resolveProductionCodegenOptions({
			appRoot: '/app',
		});
		// Unset stays unset — `@mysten/codegen`'s own default (false)
		// applies at the generateFromPackageSummary call site, so default
		// behavior is unchanged.
		expect('includePhantomTypeParameters' in resolved).toBe(false);
		expect(resolved.appRoot).toBe('/app');
	});
});

describe('buildProductionPostAcquireHook — committed-bindings (`emitBindings`) gate', () => {
	// Boot's only acquire-resolved codegen write is the deployment file (values
	// only — the dev-wallet connection + dev accounts ride the envelope's
	// `values` / `accounts` channels, no separate dev tree). The dev-`up`
	// committed-bindings refresh is gated on the threaded `emitBindings`
	// contributions; these tests pin that WIRING.

	// A known committed-bindings file the recording `emitBindings` "writes" —
	// distinct from the `deploymentFile` boot always emits, so we can assert
	// inclusion/exclusion.
	const BINDINGS_FILE = '/generated/counter/counter.ts';

	/** A codegen layer whose `emitBindings` records each call and returns a
	 *  known non-empty result, so the post-acquire hook's `codegen.emitted`
	 *  files can be asserted. Returns the call-count holder + the layer. */
	const recordingCodegen = () => {
		const calls = { emitBindings: 0 };
		const layer = Layer.succeed(CodegenOrchestratorService)({
			registerContribution: () => Effect.void,
			assembleDeployment: (network) =>
				Effect.succeed({
					defaultNetwork: network,
					networks: {
						[network]: {
							network,
							rpc: '',
							local: true,
							packages: {},
							mvrOverrides: { packages: {}, types: {} },
						},
					},
					accounts: {},
				}),
			emitBindings: () =>
				Effect.sync(() => {
					calls.emitBindings += 1;
					return {
						filesWritten: [BINDINGS_FILE],
						filesUnchanged: [],
						filesChmod: [],
						bindings: null,
					};
				}),
		} satisfies CodegenOrchestrator);
		return { calls, layer };
	};

	/** Drive `buildProductionPostAcquireHook` against an EMPTY-graph
	 *  post-acquire ctx, returning the recorded `emitBindings` call count and
	 *  the `codegen.emitted` files. */
	const runHook = (emitBindings?: ReadonlyArray<Codegenable>) =>
		Effect.gen(function* () {
			const runtimeRoot = mkdtempSync(join(tmpdir(), 'emit-bindings-gate-'));
			const { calls, layer: codegen } = recordingCodegen();
			const layer = Layer.mergeAll(
				snapshotLayer,
				codegen,
				routerLayer,
				layerManifestEndpointRegistry,
				layerCodegenPaths.pipe(
					Layer.provideMerge(
						layerCodegenRoot({
							outputDir: join(runtimeRoot, 'generated'),
							stackSubdir: null,
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
				const events = yield* Effect.scoped(
					Effect.gen(function* () {
						const hook = yield* buildProductionPostAcquireHook(
							emitBindings === undefined ? {} : { emitBindings },
						);
						// Empty graph → no routable/operational endpoints; isolates the gate.
						const ctx: SupervisorPostAcquireContext = {
							graph: {
								nodes: new Map(),
								levels: [],
								downstream: new Map(),
							} satisfies ResolvedGraph,
							registry: {} as unknown as PluginRegistry,
							identity: { ...identity, network: 'localnet' },
							runtimeRoot,
						};
						return yield* hook(ctx);
					}),
				).pipe(Effect.provide(layer));

				const emitted = events.find((event) => event.tag === 'codegen.emitted');
				if (emitted?.tag !== 'codegen.emitted') {
					return yield* Effect.die('expected a codegen.emitted event');
				}
				return {
					emitBindingsCalls: calls.emitBindings,
					files: emitted.files,
				};
			} finally {
				rmSync(runtimeRoot, { recursive: true, force: true });
			}
		});

	it.effect('emitBindings off (default) → committed bindings NOT regenerated', () =>
		Effect.gen(function* () {
			const { emitBindingsCalls, files } = yield* runHook();
			expect(emitBindingsCalls).toBe(0);
			expect(files).not.toContain(BINDINGS_FILE);
			// Only the always-emitted deployment file remains.
			expect(files).toHaveLength(1);
		}),
	);

	it.effect('emitBindings on (dev `up`) → committed bindings regenerated + listed', () =>
		Effect.gen(function* () {
			// A non-empty contributions array represents a real dev-`up` reacquire
			// (vs. the empty no-op the real impl short-circuits). The mocked
			// orchestrator ignores the contents and just records that it was called.
			const { emitBindingsCalls, files } = yield* runHook([{} as unknown as Codegenable]);
			expect(emitBindingsCalls).toBe(1);
			expect(files).toContain(BINDINGS_FILE);
		}),
	);
});
