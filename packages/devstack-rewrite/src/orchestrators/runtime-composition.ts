// Shared production orchestrator composition.
//
// CLI, programmatic runStack, and the e2e boot harness all use this
// module for capability delivery. Tests may swap service
// implementations (Traefik ops, upstream resolver, codegen paths), but
// the `OrchestratorSinks` bag and router boot step stay shared.

import { Effect, FileSystem, Layer, Scope } from 'effect';
import { isAbsolute, resolve } from 'node:path';

import {
	layerHostMoveSummaryRunner,
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
import type { PluginKey } from '../substrate/brand.ts';
import type { OrchestratorSinks } from '../substrate/runtime/capability-sinks/index.ts';
import type { SupervisorPostAcquireHook } from '../substrate/runtime/supervisor.ts';

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

export interface CapabilityDeliveryObservers {
	readonly routable?: (
		pluginKey: PluginKey,
		endpoint: EndpointUrl,
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
		layerHostMoveSummaryRunner,
		layerMystenMoveCodegen,
	);
};

export const bootRouterOrchestrator: Effect.Effect<void, never, RouterService> = Effect.gen(
	function* () {
		const router = yield* RouterService;
		yield* router.boot().pipe(Effect.orDie);
	},
);

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
			routable: (pluginKey, decl) =>
				router.boot().pipe(
					Effect.andThen(router.contributeRoute(decl)),
					Effect.flatMap((endpoint) =>
						observers.routable ? observers.routable(pluginKey, endpoint) : Effect.void,
					),
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

export const buildProductionPostAcquireHook = (): Effect.Effect<
	SupervisorPostAcquireHook,
	never,
	| CodegenOrchestratorService
	| CodegenPathsService
	| MoveSummaryRunnerService
	| MoveCodegenService
	| FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const codegen = yield* CodegenOrchestratorService;
		const paths = yield* CodegenPathsService;
		const summaryRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;
		const fs = yield* FileSystem.FileSystem;
		return () =>
			codegen.runCycle().pipe(
				Effect.provideService(CodegenPathsService, paths),
				Effect.provideService(MoveSummaryRunnerService, summaryRunner),
				Effect.provideService(MoveCodegenService, moveCodegen),
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.map((result) => [
					{
						tag: 'codegen.emitted' as const,
						files: [
							...result.filesWritten,
							...result.filesChmod,
							...(result.bindings?.filesWritten ?? []),
						],
						at: Date.now(),
					},
				]),
			);
	});

export type { EndpointUrl, ResolvedRoute };
