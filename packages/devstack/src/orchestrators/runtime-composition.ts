// Shared production orchestrator composition.
//
// CLI, programmatic runStack, and the e2e boot harness all use this
// module for capability delivery. Tests may swap service
// implementations (Traefik ops, upstream resolver, codegen paths), but
// the sink registrations and router boot step stay shared.

import { Context, Effect, FileSystem, Layer, Ref, Scope } from 'effect';
import { isAbsolute, join, resolve } from 'node:path';

import {
	layerMystenMoveCodegen,
	MoveCodegenService,
	MoveSummaryRunnerService,
} from './codegen/bindings.ts';
import { layerSuiMoveSummaryRunnerDocker } from '../plugins/sui/move-summary-runner.ts';
import { CodegenPathsService, layerCodegenPaths, layerCodegenRoot } from './codegen/paths.ts';
import {
	CodegenOrchestratorService,
	layerCodegenOrchestrator,
	type Codegenable,
} from './codegen/service.ts';
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
import { operationalEndpointEventsFromResolvedValue } from '../substrate/runtime/projection/operational-endpoints.ts';
import {
	ManifestExtrasLookupError,
	resolveManifestExtras,
	type EndpointEntry,
	type ManifestExtrasInput,
} from '../substrate/manifest.ts';
import { StackPathsService } from '../substrate/runtime/paths.ts';
import { PostAcquireTasksService } from '../substrate/runtime/post-acquire-tasks.ts';
import type {
	ContributionDispatcher,
	ContributionDispatchContext,
} from '../substrate/runtime/supervisor/contribution-dispatcher.ts';
import type {
	SupervisorPostAcquireContext,
	SupervisorPostAcquireHook,
} from '../substrate/runtime/supervisor/index.ts';

export interface ProductionCodegenOptions {
	readonly appRoot?: string;
	readonly outputDir?: string;
	readonly stackSubdir?: string | null;
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  for this stack. Threaded into `CodegenRoot.extrasDir`; recorded
	 *  in the manifest as `codegen.extrasDir` for the `@devstack-dev`
	 *  Vite alias. When omitted, falls back to
	 *  `<appRoot>/.devstack/stacks/<stack>/generated-extras` is NOT
	 *  derivable here (no stack name in scope), so the cold-start
	 *  default `<outputDir>/../generated-extras`-style fallback is left
	 *  to the resolver/Vite plugin; callers (`run-stack`, the CLI verb
	 *  wirings) always supply the resolved value. */
	readonly extrasDir?: string;
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

export interface ManifestEndpointRegistry {
	readonly register: (entry: EndpointEntry) => Effect.Effect<void, never, Scope.Scope>;
	readonly entries: Effect.Effect<ReadonlyArray<EndpointEntry>>;
}

export class ManifestEndpointRegistryService extends Context.Service<
	ManifestEndpointRegistryService,
	ManifestEndpointRegistry
>()('@devstack/orchestrators/ManifestEndpointRegistry') {}

export const layerManifestEndpointRegistry: Layer.Layer<ManifestEndpointRegistryService> =
	Layer.effect(
		ManifestEndpointRegistryService,
		Effect.gen(function* () {
			const entriesRef = yield* Ref.make<ReadonlyArray<EndpointEntry & { readonly seq: number }>>(
				[],
			);
			const seqRef = yield* Ref.make(0);

			const register = (entry: EndpointEntry): Effect.Effect<void, never, Scope.Scope> =>
				Effect.gen(function* () {
					const seq = yield* Ref.updateAndGet(seqRef, (n) => n + 1);
					yield* Ref.update(entriesRef, (entries) => [...entries, { ...entry, seq }]);
					yield* Effect.addFinalizer(() =>
						Ref.update(entriesRef, (entries) =>
							entries.filter((candidate) => candidate.seq !== seq),
						),
					);
				});

			return ManifestEndpointRegistryService.of({
				register,
				entries: Ref.get(entriesRef).pipe(
					Effect.map((entries) =>
						entries.map((entryWithSeq) => {
							const { seq, ...entry } = entryWithSeq;
							void seq;
							return entry;
						}),
					),
				),
			});
		}),
	);

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

/** Fallback `generated-extras` dir for the cold-start / no-config
 *  composition path (`buildDirectSnapshotLayers`). Callers that know
 *  their stack (`run-stack`, the verb wirings) pass the resolved
 *  per-stack value; this default only feeds direct-snapshot verbs that
 *  never run codegen. */
const productionCodegenExtrasDir = (appRoot: string, extrasDir: string | undefined): string => {
	const target = extrasDir ?? '.devstack/generated-extras';
	return isAbsolute(target) ? target : resolve(appRoot, target);
};

export const layerProductionOrchestrators = (router: ProductionRouterOptions = {}) => {
	const profile = router.profile ?? productionRouterProfile();
	return Layer.mergeAll(
		layerSnapshotOrchestrator,
		layerManifestEndpointRegistry,
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
						routeReadinessProbe: {
							enabled: router.disabled !== true,
						},
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
					extrasDir: productionCodegenExtrasDir(
						router.codegen?.appRoot ?? process.cwd(),
						router.codegen?.extrasDir,
					),
				}),
			),
		),
		layerSuiMoveSummaryRunnerDocker,
		layerMystenMoveCodegen,
	);
};

export const bootRouterOrchestrator: Effect.Effect<void, never, RouterService> = Effect.gen(
	function* () {
		const router = yield* RouterService;
		yield* router.boot().pipe(Effect.orDie);
	},
);

/** Project a `(pluginKey, EndpointUrl)` pair into the field-set both
 *  the engine event and the manifest entry stamp identically. Callers
 *  spread this and then add their output-specific fields (the engine
 *  event's branded `endpointKey` + `registeredAt`; the manifest
 *  entry's stringified `endpointKey` + `pluginKey`). */
const routableToEndpointFields = (
	pluginKey: PluginKey,
	endpoint: EndpointUrl,
): {
	readonly name: string;
	readonly url: string;
	readonly displayUrl: null;
	readonly wireProtocol: EndpointUrl['wireProtocol'];
	readonly endpointKeyString: string;
} => ({
	name: endpoint.endpointName,
	url: endpoint.url,
	displayUrl: null,
	wireProtocol: endpoint.wireProtocol,
	endpointKeyString: `${pluginKey}:${endpoint.endpointName}`,
});

export const endpointEventFromRoutable = (
	pluginKey: PluginKey,
	endpoint: EndpointUrl,
	registeredAt = Date.now(),
): Extract<EngineEvent, { readonly tag: 'endpoint.registered' }> => {
	const { endpointKeyString, ...common } = routableToEndpointFields(pluginKey, endpoint);
	return {
		tag: 'endpoint.registered',
		endpoint: {
			...common,
			endpointKey: endpointKey(endpointKeyString),
			pluginKey,
			registeredAt,
		},
	};
};

export const manifestEndpointEntryFromRoutable = (
	pluginKey: PluginKey,
	endpoint: EndpointUrl,
): EndpointEntry => {
	const { endpointKeyString, ...common } = routableToEndpointFields(pluginKey, endpoint);
	return {
		...common,
		endpointKey: endpointKeyString,
		pluginKey: String(pluginKey),
	};
};

const manifestEndpointEntryFromOperationalEndpoint = (
	endpoint: Extract<EngineEvent, { readonly tag: 'endpoint.registered' }>['endpoint'],
): EndpointEntry => ({
	endpointKey: String(endpoint.endpointKey),
	name: endpoint.name,
	url: endpoint.url,
	displayUrl: endpoint.displayUrl,
	wireProtocol: endpoint.wireProtocol,
	pluginKey: String(endpoint.pluginKey),
});

/** Project a projection decl's `rowKey` (when absent) onto the
 *  contributing plugin so projection consumers can attribute the row.
 *  The payload stays opaque from the substrate's POV.
 *
 *  RELOCATED orchestrator seam — byte-identical to the old projection
 *  sink body, not net-new logic; it moved here from the deleted
 *  CapabilitySinks loop. (`strategyContributorDispatch` below is NOT
 *  byte-identical — it absorbed the `strategyRegistry.register` priority
 *  argument when the seam moved.) */
const projectionDispatch = (
	decl: ProjectionDecl,
	ctx: ContributionDispatchContext,
): Effect.Effect<void, never, never> => {
	const payload = decl.event.payload;
	const payloadWithRowKey =
		payload !== null &&
		typeof payload === 'object' &&
		'rowKey' in payload &&
		(payload as { rowKey: unknown }).rowKey === null
			? { ...payload, rowKey: ctx.pluginKey }
			: payload;
	return ctx.publish({
		...decl.event,
		payload: payloadWithRowKey,
	});
};

/** Register a strategy contribution on the scope-local registry, publish
 *  `strategy.registered`, and arm a finalizer publishing
 *  `strategy.unregistered`. (Was `makeStrategyContributorCapabilitySink`.) */
const strategyContributorDispatch = (
	decl: StrategyContributorDecl<string, unknown>,
	ctx: ContributionDispatchContext,
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		yield* ctx.strategyRegistry.register(decl.capabilityKey, decl.strategy, {
			autoMounted: decl.autoMounted,
			...(decl.priority === undefined ? {} : { priority: decl.priority }),
		});
		yield* ctx.publish({
			tag: 'strategy.registered',
			capabilityKey: decl.capabilityKey,
			autoMounted: decl.autoMounted,
			at: Date.now(),
		});
		yield* Effect.addFinalizer(() =>
			ctx.publish({
				tag: 'strategy.unregistered',
				capabilityKey: decl.capabilityKey,
				at: Date.now(),
			}),
		);
	});

/**
 * Build the production `ContributionDispatcher` — the closed seam the
 * supervisor replays each plugin's buffered contributions through after
 * a successful `start`. Each method's body reads its backing orchestrator
 * service (Snapshot/Router/Codegen/ManifestEndpoint) ONCE here and closes
 * over it; the substrate supervisor holds the resulting record opaquely
 * (it never imports an orchestrator service). Replaces the deleted
 * `buildProductionOrchestratorSinks` array assembly.
 */
export const buildProductionContributionDispatcher = (
	observers: CapabilityDeliveryObservers = {},
): Effect.Effect<
	ContributionDispatcher,
	never,
	| SnapshotOrchestratorService
	| RouterService
	| CodegenOrchestratorService
	| ManifestEndpointRegistryService
> =>
	Effect.gen(function* () {
		const snapshot = yield* SnapshotOrchestratorService;
		const router = yield* RouterService;
		const codegen = yield* CodegenOrchestratorService;
		const manifestEndpoints = yield* ManifestEndpointRegistryService;
		return {
			snapshotable: (decl: SnapshotableDecl, ctx) =>
				snapshot.registerParticipant(ctx.pluginKey, decl),
			routable: (decl: RoutableDecl, ctx) =>
				router.boot().pipe(
					Effect.andThen(router.contributeRoute(decl)),
					Effect.flatMap((endpoint) => {
						const event = endpointEventFromRoutable(ctx.pluginKey, endpoint);
						const manifestEntry = manifestEndpointEntryFromRoutable(ctx.pluginKey, endpoint);
						return manifestEndpoints
							.register(manifestEntry)
							.pipe(
								Effect.andThen(ctx.publish(event)),
								Effect.andThen(
									observers.routable
										? observers.routable(ctx.pluginKey, endpoint, event)
										: Effect.void,
								),
							);
					}),
				),
			codegenable: (decl: Codegenable, ctx) =>
				codegen
					.registerContribution(ctx.pluginKey, decl)
					.pipe(
						Effect.flatMap(() =>
							observers.codegenable ? observers.codegenable(ctx.pluginKey, decl) : Effect.void,
						),
					),
			projection: (decl: ProjectionDecl, ctx) => projectionDispatch(decl, ctx),
			strategyContributor: (decl: StrategyContributorDecl<string, unknown>, ctx) =>
				strategyContributorDispatch(decl, ctx),
		} satisfies ContributionDispatcher;
	});

const makeManifestExtrasContext = (ctx: SupervisorPostAcquireContext) => {
	const resourceIdToKey = new Map<string, PluginKey>();
	for (const [key, node] of ctx.graph.nodes) {
		resourceIdToKey.set(node.member.id, key);
	}
	// `lookup` throws `ManifestExtrasLookupError` synchronously from
	// inside the user-supplied `extras` factory.
	// `resolveManifestExtras` invokes that factory under `Effect.try`
	// with a typed `catch` mapper, so the throw promotes to the typed
	// failure channel — callers `catchTag('ManifestExtrasLookupError',
	// ...)` rather than reading the die-cause. Non-tagged throws stay
	// defects, preserving the previous semantics for genuine
	// programmer errors inside the factory body.
	const lookup = (resourceId: string): unknown => {
		const key = resourceIdToKey.get(resourceId);
		if (key === undefined) {
			throw new ManifestExtrasLookupError({
				kind: 'unknown-resource',
				resourceId,
			});
		}
		const resolved = readResolvedSync(ctx.registry, key);
		if (resolved === undefined) {
			throw new ManifestExtrasLookupError({
				kind: 'unresolved-resource',
				resourceId,
			});
		}
		return resolved;
	};
	return {
		value: (resource: { readonly id: string }) => lookup(resource.id),
	};
};

const operationalManifestEndpointEntries = (
	ctx: SupervisorPostAcquireContext,
	routableEntries: ReadonlyArray<EndpointEntry>,
): ReadonlyArray<EndpointEntry> => {
	const routablePluginKeys = new Set(routableEntries.map((entry) => entry.pluginKey));
	const registeredAt = Date.now();
	const entries: EndpointEntry[] = [];
	for (const [key] of ctx.graph.nodes) {
		if (routablePluginKeys.has(String(key))) continue;
		const resolved = readResolvedSync(ctx.registry, key);
		if (resolved === undefined) continue;
		for (const event of operationalEndpointEventsFromResolvedValue(key, resolved, registeredAt)) {
			entries.push(manifestEndpointEntryFromOperationalEndpoint(event.endpoint));
		}
	}
	return entries;
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
	| ManifestEndpointRegistryService
> =>
	Effect.gen(function* () {
		const codegen = yield* CodegenOrchestratorService;
		const paths = yield* CodegenPathsService;
		const summaryRunner = yield* MoveSummaryRunnerService;
		const moveCodegen = yield* MoveCodegenService;
		const fs = yield* FileSystem.FileSystem;
		const stackPaths = yield* StackPathsService;
		const postAcquireTasks = yield* PostAcquireTasksService;
		const manifestEndpoints = yield* ManifestEndpointRegistryService;
		return (ctx) =>
			Effect.gen(function* () {
				const extras = yield* resolveManifestExtras(options.extras, makeManifestExtrasContext(ctx));
				const routableEndpoints = yield* manifestEndpoints.entries;
				const endpoints = [
					...routableEndpoints,
					...operationalManifestEndpointEntries(ctx, routableEndpoints),
				];
				const envelope = yield* buildEnvelope({
					identity: {
						app: ctx.identity.app,
						stack: ctx.identity.stack,
						chain: ctx.identity.chain,
					},
					contributions: [],
					endpoints,
					extras,
					// Record the EXACT dirs codegen emits into for this stack so
					// the read-side `@generated` / `@devstack-dev` aliases (the
					// Vite plugin) point where the files actually are — one
					// decision, one source of truth
					// (notes/per-stack-codegen-design.md §"Resolved: read and
					// write share one gate"). `paths.outputDir` is the resolved,
					// stack-subdir-applied absolute path the runtime tree writes
					// to; `paths.extrasDir` is the dev-only `generated-extras`
					// tree the `@devstack-dev` alias resolves.
					codegen: { generatedDir: paths.outputDir, extrasDir: paths.extrasDir },
				});
				const manifestPath = join(stackPaths.stackRoot, 'manifest.json');
				yield* writeManifest(envelope, manifestPath).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
				);
				const result = yield* codegen
					.runCycle()
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
