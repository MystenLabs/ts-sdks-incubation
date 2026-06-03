// Built-in plugin runtime composition.
//
// Orchestrator-layer composition (L3): depends on L2 plugin internals
// (coin/package registries), so it cannot live at L1 runtime. Lives in
// src/orchestrators/ to honor the ARCHITECTURE.md L1-never-imports-from-L2
// boundary.

import { Context, Effect, FileSystem, Layer } from 'effect';

import { SnapshotOrchestratorService } from './snapshot/index.ts';
import { CoinRegistryService, layerCoinRegistry } from '../plugins/coin/registry.ts';
import { PackageRegistryService, layerPackageRegistry } from '../plugins/package/registry.ts';

export const layerBuiltInPluginServices: Layer.Layer<CoinRegistryService | PackageRegistryService> =
	Layer.mergeAll(layerCoinRegistry, layerPackageRegistry);

/** Built-in plugin runtime: the per-stack coin + package registries.
 *  Coin auto-discovery from a fresh package publish now runs DIRECTLY in
 *  the package plugin's `start` (folding the publish output into the
 *  CoinRegistry), so there is no longer a `publishResultSink` /
 *  `CapabilitySinks` layer here — the registries are the whole surface. */
export const layerBuiltInPluginRuntime: Layer.Layer<CoinRegistryService | PackageRegistryService> =
	layerBuiltInPluginServices;

export const extendBuiltInPluginContext = (
	ctx: Context.Context<never>,
): Effect.Effect<
	Context.Context<never>,
	never,
	CoinRegistryService | PackageRegistryService | SnapshotOrchestratorService | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const coinRegistry = yield* CoinRegistryService;
		const packageRegistry = yield* PackageRegistryService;
		// Thread the snapshot orchestrator + filesystem into the plugin
		// runtime context so the supervisor can populate the control-plane
		// `domain` surface (snapshot list/restore/delete, which never
		// round-trip through the void `publishCommand`). The
		// `ContainerRuntimeService` the domain also needs is already in the
		// base substrate plugin context.
		const snapshotOrchestrator = yield* SnapshotOrchestratorService;
		const fileSystem = yield* FileSystem.FileSystem;
		return ctx.pipe(
			Context.add(CoinRegistryService, coinRegistry),
			Context.add(PackageRegistryService, packageRegistry),
			Context.add(SnapshotOrchestratorService, snapshotOrchestrator),
			Context.add(FileSystem.FileSystem, fileSystem),
		) as Context.Context<never>;
	});
