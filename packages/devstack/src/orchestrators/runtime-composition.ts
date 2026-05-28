// Shared production orchestrator composition.
//
// CLI, programmatic runStack, and the e2e boot harness all use this
// module for capability delivery. Tests may swap service
// implementations (Traefik ops, upstream resolver, codegen paths), but
// the sink registrations and router boot step stay shared.

import { Context, Data, Effect, FileSystem, Layer, Ref, Scope } from 'effect';
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
import type { CodegenableDecl } from '../contracts/codegenable.ts';
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
import { operationalEndpointEventsFromResolvedValue } from '../substrate/runtime/projection/operational-endpoints.ts';
import {
	resolveManifestExtras,
	type EndpointEntry,
	type ManifestExtras,
	type ManifestExtrasInput,
} from '../substrate/manifest.ts';
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
} from '../substrate/runtime/supervisor/index.ts';

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

/** Codegenable wrapping the resolved manifest-extras blob into a
 *  generated `extras.ts` for app-side consumption. Single-callsite
 *  helper — declared here to keep the orchestrator's view of the
 *  contribution self-contained. */
const makeExtrasCodegenable = (extras: ManifestExtras): CodegenableDecl<'app-extras'> => ({
	kind: 'codegenable',
	emitterName: 'app-extras',
	outputPath: 'extras.ts',
	sensitive: true,
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('extras', extras);
			return ctx.done();
		}),
});

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

export const endpointEventFromRoutable = (
	pluginKey: PluginKey,
	endpoint: EndpointUrl,
	registeredAt = Date.now(),
): Extract<EngineEvent, { readonly tag: 'endpoint.registered' }> => ({
	tag: 'endpoint.registered',
	endpoint: {
		endpointKey: endpointKey(`${pluginKey}:${endpoint.endpointName}`),
		pluginKey,
		name: endpoint.endpointName,
		url: endpoint.url,
		displayUrl: null,
		wireProtocol: endpoint.wireProtocol,
		registeredAt,
	},
});

export const manifestEndpointEntryFromRoutable = (
	pluginKey: PluginKey,
	endpoint: EndpointUrl,
): EndpointEntry => ({
	endpointKey: `${pluginKey}:${endpoint.endpointName}`,
	name: endpoint.endpointName,
	url: endpoint.url,
	displayUrl: null,
	wireProtocol: endpoint.wireProtocol,
	pluginKey: String(pluginKey),
});

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

const orchestratorSink = <K extends ContributionKind, TDecl>(
	sink: CapabilitySink<K, TDecl>,
): OrchestratorSinks[number] => sink as OrchestratorSinks[number];

export const makeProjectionCapabilitySink = (): OrchestratorSinks[number] =>
	orchestratorSink<'projection', ProjectionDecl>({
		kind: 'projection',
		accept: (decl, ctx) =>
			Effect.gen(function* () {
				// Stamp `rowKey` (when absent) so projection consumers can
				// attribute the row to the contributing plugin. The payload
				// stays opaque from the substrate's POV; we project just
				// enough to set the row-key field if the payload exposes it.
				const payload = decl.event.payload;
				const payloadWithRowKey =
					payload !== null &&
					typeof payload === 'object' &&
					'rowKey' in payload &&
					(payload as { rowKey: unknown }).rowKey === null
						? { ...payload, rowKey: ctx.pluginKey }
						: payload;
				yield* ctx.publish({
					...decl.event,
					payload: payloadWithRowKey,
				});
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

/** Failure surfaced when `extras` references a resource the supervisor
 *  doesn't know about, or one that hasn't resolved yet. Thrown
 *  synchronously from inside the `ManifestExtrasContext.value` closure
 *  (the user-supplied `extras` factory invokes it synchronously); the
 *  Effect runtime captures it as a tagged defect that the
 *  cascade-formatter projects via `_tag`. */
export class ManifestExtrasLookupError extends Data.TaggedError('ManifestExtrasLookupError')<{
	readonly kind: 'unknown-resource' | 'unresolved-resource';
	readonly resourceId: string;
}> {}

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
