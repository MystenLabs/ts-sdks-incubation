// Built-in plugin runtime composition.
//
// L0 substrate builds only name-blind services. This module is the higher-level
// composition point for built-in plugin services and built-in capability sinks.

import { Context, Effect, Layer } from 'effect';

import { discoverCoinsFromPublish } from '../plugins/coin/discovery.ts';
import {
	CoinRegistryService,
	coinRegistryLayer,
	type CoinRecord,
} from '../plugins/coin/registry.ts';
import {
	LOCAL_PACKAGE_PUBLISHED_KIND,
	type LocalPackagePublishedDecl,
} from '../plugins/package/publish-output.ts';
import { PackageRegistryService, layerPackageRegistry } from '../plugins/package/registry.ts';
import {
	CapabilitySinksService,
	layerCapabilitySinksDefault,
	type CapabilitySink,
	type OrchestratorSinks,
} from '../substrate/runtime/capability-sinks/index.ts';

export const layerBuiltInPluginServices: Layer.Layer<CoinRegistryService | PackageRegistryService> =
	Layer.mergeAll(coinRegistryLayer, layerPackageRegistry);

const publishResultSink = (
	coinRegistry: typeof CoinRegistryService.Service,
): CapabilitySink<typeof LOCAL_PACKAGE_PUBLISHED_KIND, LocalPackagePublishedDecl> => ({
	kind: LOCAL_PACKAGE_PUBLISHED_KIND,
	accept: (decl) =>
		Effect.gen(function* () {
			for (const discovered of discoverCoinsFromPublish(decl.output)) {
				const record: CoinRecord = {
					key: (discovered.symbol ?? discovered.witness).toLowerCase(),
					type: discovered.fullCoinType,
					witness: discovered.witness,
					moduleName: discovered.moduleName,
					decimals: discovered.decimals ?? 0,
					...(discovered.symbol === undefined ? {} : { symbol: discovered.symbol }),
					...(discovered.displayName === undefined
						? {}
						: { displayName: discovered.displayName }),
					...(discovered.iconUrl === undefined ? {} : { iconUrl: discovered.iconUrl }),
					...(!discovered.publisherOwnsCap || discovered.treasuryCapId === undefined
						? {}
						: { treasuryCapId: discovered.treasuryCapId }),
					...(discovered.metadataId === undefined ? {} : { metadataId: discovered.metadataId }),
					packageId: decl.packageId,
					publishingPackageName: decl.packageName,
				};
				yield* coinRegistry.register(record);
			}
		}),
});

export const layerBuiltInCapabilitySinks = (
	orchestrator: OrchestratorSinks,
): Layer.Layer<CapabilitySinksService, never, CoinRegistryService | PackageRegistryService> => {
	const registerBuiltInPluginSinks = Layer.effectDiscard(
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const coinRegistry = yield* CoinRegistryService;
			yield* sinks.registerSink(publishResultSink(coinRegistry));
		}),
	);
	return registerBuiltInPluginSinks.pipe(
		Layer.provideMerge(layerCapabilitySinksDefault(orchestrator)),
	);
};

export const layerBuiltInPluginRuntime = (
	orchestrator: OrchestratorSinks,
): Layer.Layer<CoinRegistryService | PackageRegistryService | CapabilitySinksService> =>
	layerBuiltInCapabilitySinks(orchestrator).pipe(Layer.provideMerge(layerBuiltInPluginServices));

export const extendBuiltInPluginContext = (
	ctx: Context.Context<never>,
): Effect.Effect<
	Context.Context<never>,
	never,
	CoinRegistryService | PackageRegistryService | CapabilitySinksService
> =>
	Effect.gen(function* () {
		const coinRegistry = yield* CoinRegistryService;
		const packageRegistry = yield* PackageRegistryService;
		const capabilitySinks = yield* CapabilitySinksService;
		return ctx.pipe(
			Context.add(CoinRegistryService, coinRegistry),
			Context.add(PackageRegistryService, packageRegistry),
			Context.add(CapabilitySinksService, capabilitySinks),
		) as Context.Context<never>;
	});
