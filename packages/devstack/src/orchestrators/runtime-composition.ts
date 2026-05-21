// Shared production orchestrator composition.
//
// CLI, programmatic runStack, and the e2e boot harness all use this
// module for capability delivery. Tests may swap service
// implementations (Traefik ops, upstream resolver, codegen paths), but
// the `OrchestratorSinks` bag and router boot step stay shared.

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
	DEFAULT_ENTRYPOINTS,
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
import {
	makeDefaultRouterProfile,
	type DefaultRouterProfileOptions,
	type RouterProfile,
} from './router/profile.ts';
import { layerSnapshotOrchestrator, SnapshotOrchestratorService } from './snapshot/index.ts';
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
import type { OrchestratorSinks } from '../substrate/runtime/capability-sinks/index.ts';
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
					layerEntrypointRegistry(DEFAULT_ENTRYPOINTS),
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
		return {
			snapshotable: (pluginKey, decl) => snapshot.registerParticipant(pluginKey, decl),
			liveness: (pluginKey, decl) => snapshot.registerClassifier(pluginKey, decl),
			routable: (pluginKey, decl, ctx) =>
				router.boot().pipe(
					Effect.andThen(router.contributeRoute(decl)),
					Effect.flatMap((endpoint) => {
						const event = endpointEventFromRoutable(pluginKey, endpoint);
						return ctx.publish(event).pipe(
							Effect.andThen(
								observers.routable
									? observers.routable(pluginKey, endpoint, event)
									: Effect.void,
							),
						);
					}),
					Effect.orDie,
				),
			codegenable: (pluginKey, decl) =>
				codegen
					.registerContribution(pluginKey, decl)
					.pipe(
						Effect.flatMap(() =>
							observers.codegenable ? observers.codegenable(pluginKey, decl) : Effect.void,
						),
					),
		};
	});

const makeManifestExtrasContext = (ctx: SupervisorPostAcquireContext) => {
	const tagIdToKey = new Map<string, PluginKey>();
	for (const [key, node] of ctx.graph.nodes) {
		tagIdToKey.set(node.member.provides.id, key);
	}
	const lookup = (tagId: string): unknown => {
		const key = tagIdToKey.get(tagId);
		if (key === undefined) {
			throw new Error(`manifest extras requested unknown tag '${tagId}'`);
		}
		const resolved = readResolvedSync(ctx.registry, key);
		if (resolved === undefined) {
			throw new Error(`manifest extras requested unresolved tag '${tagId}'`);
		}
		return resolved;
	};
	return {
		get: (tag: { readonly id: string }) => lookup(tag.id),
		use: (member: { readonly provides: { readonly id: string } }) => lookup(member.provides.id),
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
> =>
	Effect.gen(function* () {
		const codegen = yield* CodegenOrchestratorService;
		const paths = yield* CodegenPathsService;
		const summaryRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;
		const fs = yield* FileSystem.FileSystem;
		const stackPaths = yield* StackPathsService;
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
