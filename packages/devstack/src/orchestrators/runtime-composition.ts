// Shared production orchestrator composition.
//
// CLI, programmatic runStack, and the e2e boot harness all use this
// module for capability delivery. Tests may swap service
// implementations (Traefik ops, upstream resolver, codegen paths), but
// the sink registrations and router boot step stay shared.

import { Effect, FileSystem, Layer, Scope } from 'effect';
import { isAbsolute, join, resolve } from 'node:path';

import {
	layerDockerMoveSummaryRunner,
	layerMystenMoveCodegen,
	MoveCodegenService,
	MoveSummaryRunnerService,
} from './codegen/bindings.ts';
import { CodegenPathsService, layerCodegenPaths, layerCodegenRoot } from './codegen/paths.ts';
import {
	CodegenOrchestratorService,
	layerCodegenOrchestrator,
	type Codegenable,
} from './codegen/service.ts';
import { makeExtrasCodegenable } from './codegen/extras.ts';
import {
	DEFAULT_TRAEFIK_IMAGE,
	layerDockerUpstreamResolver,
	layerEntrypointRegistry,
	layerRouterConfigLiteral,
	layerRouterService,
	layerTraefikContainerOpsDocker,
	RouterService,
	type EndpointUrl,
	type ResolvedRoute,
} from './router/index.ts';
import { BUILT_IN_ENTRYPOINTS } from '../plugins/router-entrypoints.ts';
import {
	makeDefaultRouterProfile,
	type DefaultRouterProfileOptions,
	type RouterProfile,
} from './router/profile.ts';
import { layerSnapshotOrchestrator, SnapshotOrchestratorService } from './snapshot/index.ts';
import type { LivenessClassifierDecl } from '../contracts/liveness-classifier.ts';
import type { ProjectionDecl } from '../contracts/projection.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';
import { endpointKey, type PluginKey } from '../substrate/brand.ts';
import type { EngineEvent } from '../substrate/events.ts';
import {
	buildEnvelope,
	CURRENT_MANIFEST_VERSION,
	writeManifest,
} from '../substrate/runtime/manifest/index.ts';
import { readResolvedSync } from '../substrate/runtime/lifecycle/index.ts';
import { resolveManifestExtras, type ManifestExtrasInput } from '../substrate/manifest.ts';
import { StackPathsService } from '../substrate/runtime/paths.ts';
import { PostAcquireTasksService } from '../substrate/runtime/post-acquire-tasks.ts';
import type {
	CapabilitySink,
	ContributionKind,
	HarvestContext,
	OrchestratorSinks,
} from '../substrate/runtime/capability-sinks/index.ts';
import type {
	SupervisorPostAcquireContext,
	SupervisorPostAcquireHook,
} from '../substrate/runtime/supervisor.ts';

export interface ProductionCodegenOptions {
	readonly appRoot?: string;
	readonly outputDir?: string;
	readonly stackSubdir?: string | null;
}

export interface ProductionRouterOptions {
	readonly codegen?: ProductionCodegenOptions;
	readonly disabled?: boolean;
	readonly image?: string;
	readonly profile?: RouterProfile;
}

export interface ProductionPostAcquireOptions {
	readonly extras?: ManifestExtrasInput;
}

export interface CapabilityDeliveryObservers {
	readonly routable?: (
		pluginKey: PluginKey,
		endpoint: EndpointUrl,
		event: Extract<EngineEvent, { readonly tag: 'endpoint.registered' }>,
	) => Effect.Effect<void, never, Scope.Scope>;
	readonly codegenable?: (
		pluginKey: PluginKey,
		decl: Codegenable,
	) => Effect.Effect<void, never, Scope.Scope>;
}

export const productionRouterProfile = (options: DefaultRouterProfileOptions = {}): RouterProfile =>
	makeDefaultRouterProfile(options);

const productionCodegenOutputDir = (appRoot: string, outputDir: string | undefined): string => {
	const target = outputDir ?? 'src/generated';
	return isAbsolute(target) ? target : resolve(appRoot, target);
};

export const layerProductionOrchestrators = (router: ProductionRouterOptions = {}) => {
	const profile = router.profile ?? productionRouterProfile();
	return Layer.mergeAll(
		layerSnapshotOrchestrator,
		layerRouterService.pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					layerEntrypointRegistry(BUILT_IN_ENTRYPOINTS),
					layerTraefikContainerOpsDocker,
					layerDockerUpstreamResolver(profile),
					layerRouterConfigLiteral({
						disabled: router.disabled ?? false,
						profile,
						image: router.image ?? DEFAULT_TRAEFIK_IMAGE,
					}),
				),
			),
		),
		layerCodegenOrchestrator,
		layerCodegenPaths.pipe(
			Layer.provideMerge(
				layerCodegenRoot({
					outputDir: productionCodegenOutputDir(
						router.codegen?.appRoot ?? process.cwd(),
						router.codegen?.outputDir,
					),
					stackSubdir: router.codegen?.stackSubdir ?? null,
				}),
			),
		),
		layerDockerMoveSummaryRunner,
		layerMystenMoveCodegen,
	);
};

export const bootRouterOrchestrator: Effect.Effect<void, never, RouterService> = Effect.gen(
	function* () {
		const router = yield* RouterService;
		yield* router.boot().pipe(Effect.orDie);
	},
);

export const endpointEventFromRoutable = (
	pluginKey: PluginKey,
	endpoint: EndpointUrl,
	registeredAt = Date.now(),
): Extract<EngineEvent, { readonly tag: 'endpoint.registered' }> => ({
	tag: 'endpoint.registered',
	endpoint: {
		endpointKey: endpointKey(`${pluginKey}:${endpoint.endpointName}`),
		name: endpoint.endpointName,
		url: endpoint.url,
		displayUrl: null,
		wireProtocol: endpoint.wireProtocol,
		registeredAt,
	},
});

const orchestratorSink = <K extends ContributionKind, TDecl>(
	sink: CapabilitySink<K, TDecl>,
): OrchestratorSinks[number] => sink as OrchestratorSinks[number];

export const makeProjectionCapabilitySink = (): OrchestratorSinks[number] =>
	orchestratorSink<'projection', ProjectionDecl>({
		kind: 'projection',
		accept: (decl, ctx) =>
			Effect.gen(function* () {
				const event =
					decl.event.tag === 'account.updated'
						? {
								...decl.event,
								account: {
									...decl.event.account,
									rowKey: decl.event.account.rowKey ?? ctx.pluginKey,
								},
							}
						: {
								...decl.event,
								package: {
									...decl.event.package,
									rowKey: decl.event.package.rowKey ?? ctx.pluginKey,
								},
							};
				yield* ctx.publish(event);
			}),
	});

export const makeStrategyContributorCapabilitySink = (): OrchestratorSinks[number] =>
	orchestratorSink<'strategy-contributor', StrategyContributorDecl<string, unknown>>({
		kind: 'strategy-contributor',
		accept: (decl, ctx) =>
			Effect.gen(function* () {
				yield* ctx.registerStrategy(decl);
				const at = Date.now();
				yield* ctx.publish({
					tag: 'strategy.registered',
					capabilityKey: decl.capabilityKey,
					autoMounted: decl.autoMounted,
					at,
				});
				yield* Effect.addFinalizer(() =>
					ctx.publish({
						tag: 'strategy.unregistered',
						capabilityKey: decl.capabilityKey,
						at: Date.now(),
					}),
				);
			}),
	});

export const buildProductionOrchestratorSinks = (
	observers: CapabilityDeliveryObservers = {},
): Effect.Effect<
	OrchestratorSinks,
	never,
	SnapshotOrchestratorService | RouterService | CodegenOrchestratorService
> =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const router = yield* RouterService;
		const codegen = yield* CodegenOrchestratorService;
		return [
			orchestratorSink<'snapshotable', SnapshotableDecl>({
				kind: 'snapshotable',
				accept: (decl, ctx) => snapshot.registerParticipant(ctx.pluginKey, decl),
			}),
			orchestratorSink<'liveness-classifier', LivenessClassifierDecl>({
				kind: 'liveness-classifier',
				accept: (decl, ctx) => snapshot.registerClassifier(ctx.pluginKey, decl),
			}),
			orchestratorSink<'routable', RoutableDecl>({
				kind: 'routable',
				accept: (decl, ctx: HarvestContext) =>
					router.boot().pipe(
						Effect.andThen(router.contributeRoute(decl)),
						Effect.flatMap((endpoint) => {
							const event = endpointEventFromRoutable(ctx.pluginKey, endpoint);
							return ctx
								.publish(event)
								.pipe(
									Effect.andThen(
										observers.routable
											? observers.routable(ctx.pluginKey, endpoint, event)
											: Effect.void,
									),
								);
						}),
					),
			}),
			orchestratorSink<'codegenable', Codegenable>({
				kind: 'codegenable',
				accept: (decl, ctx) =>
					codegen
						.registerContribution(ctx.pluginKey, decl)
						.pipe(
							Effect.flatMap(() =>
								observers.codegenable ? observers.codegenable(ctx.pluginKey, decl) : Effect.void,
							),
						),
			}),
			makeProjectionCapabilitySink(),
			makeStrategyContributorCapabilitySink(),
		];
	});

const makeManifestExtrasContext = (ctx: SupervisorPostAcquireContext) => {
	const resourceIdToKey = new Map<string, PluginKey>();
	for (const [key, node] of ctx.graph.nodes) {
		resourceIdToKey.set(node.member.id, key);
	}
	const lookup = (resourceId: string): unknown => {
		const key = resourceIdToKey.get(resourceId);
		if (key === undefined) {
			throw new Error(`manifest extras requested unknown resource '${resourceId}'`);
		}
		const resolved = readResolvedSync(ctx.registry, key);
		if (resolved === undefined) {
			throw new Error(`manifest extras requested unresolved resource '${resourceId}'`);
		}
		return resolved;
	};
	return {
		value: (resource: { readonly id: string }) => lookup(resource.id),
	};
};

export const buildProductionPostAcquireHook = (
	options: ProductionPostAcquireOptions = {},
): Effect.Effect<
	SupervisorPostAcquireHook,
	never,
	| CodegenOrchestratorService
	| CodegenPathsService
	| MoveSummaryRunnerService
	| MoveCodegenService
	| FileSystem.FileSystem
	| StackPathsService
	| PostAcquireTasksService
> =>
	Effect.gen(function* () {
		const codegen = yield* CodegenOrchestratorService;
		const paths = yield* CodegenPathsService;
		const summaryRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;
		const fs = yield* FileSystem.FileSystem;
		const stackPaths = yield* StackPathsService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		return (ctx) =>
			Effect.gen(function* () {
				const extras = yield* resolveManifestExtras(options.extras, makeManifestExtrasContext(ctx));
				const envelope = yield* buildEnvelope({
					identity: {
						app: ctx.identity.app,
						stack: ctx.identity.stack,
						chain: ctx.identity.chain,
					},
					contributions: [],
					extras,
				});
				const manifestPath = join(stackPaths.stackRoot, 'manifest.json');
				yield* writeManifest(envelope, manifestPath).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
				);
				const result = yield* codegen
					.runCycle({ extraContributions: [makeExtrasCodegenable(extras)] })
					.pipe(
						Effect.provideService(CodegenPathsService, paths),
						Effect.provideService(MoveSummaryRunnerService, summaryRunner),
						Effect.provideService(MoveCodegenService, moveCodegen),
						Effect.provideService(FileSystem.FileSystem, fs),
					);
				yield* postAcquireTasks.runAll;
				return [
					{
						tag: 'manifest.flushed' as const,
						manifestVersion: CURRENT_MANIFEST_VERSION,
						at: Date.now(),
					},
					{
						tag: 'codegen.emitted' as const,
						files: [
							...result.filesWritten,
							...result.filesChmod,
							...(result.bindings?.filesWritten ?? []),
						],
						at: Date.now(),
					},
				];
			});
	});

export type { EndpointUrl, ResolvedRoute };
