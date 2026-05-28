// Lifecycle prune orchestrator — cross-stack Docker sweep.
//
// Architecture § L3 orchestrators. Walks the L1 docker inventory (the
// reference `ContainerRuntime` adapter), groups labelled resources by
// `(app, stack)`, consults the cross-process roster + claim ledger for
// liveness, and dispatches removal through the sibling router cleanup
// helper for router-shared resources.
//
// Name-blindness: this orchestrator never names a service. It walks
// the engine label tuple (`LabelKey.app` / `LabelKey.stack`) which is
// L1-substrate-level vocabulary and dispatches on the
// `ROUTER_SHARED_APP` sentinel exported by the router orchestrator.
//
// Consumers: `cli/prune-direct.ts` (the L4-adjacent CLI infrastructure
// for the `devstack prune` verb) calls `runLifecyclePrune` /
// `collectLifecyclePruneInventory`. No L4 surface module imports L1
// runtime adapters directly; that boundary lives here.

import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import {
	DockerHost,
	DockerSpawner,
	type ForeignNetworkHolder,
	LabelKey,
	layerDockerHostDefault,
	listDevstackContainers,
	listDevstackContainersByKind,
	listDevstackImages,
	listDevstackNetworks,
	listDevstackVolumes,
	removeDevstackContainers,
	removeDevstackContainersByKindAndName,
	removeDevstackImages,
	removeDevstackNetworksBestEffort,
	removeDevstackVolumes,
	type StaleNetworkEndpoint,
} from '../../runtime/docker/index.ts';
import {
	layerLivenessProbeScope,
	LivenessProbeScope,
	readRoster,
} from '../../substrate/runtime/cross-process/index.ts';
import { PER_APP_SHARED_STACK } from '../../substrate/runtime/managed-container.ts';
import { logDebugAndFallback } from '../../substrate/runtime/observability/index.ts';
import { ROUTER_SHARED_APP, removeRouterProfileStateForDockerStack } from '../router/cleanup.ts';
import { ROUTER_KIND_LABEL_VALUE } from '../router/traefik-container.ts';
import { failPhase, type LifecyclePruneError } from './errors.ts';

export { LifecyclePruneError, LifecyclePrunePhase } from './errors.ts';

// -----------------------------------------------------------------------------
// Public shapes — mirror `surfaces/cli/commands/prune.ts` field-for-field so
// the verb dispatcher can consume the orchestrator output without an adapter.
// -----------------------------------------------------------------------------

export interface LifecyclePruneOptions {
	readonly runtimeRoot: string;
}

export interface LifecyclePruneGroup {
	readonly key: string;
	readonly app: string;
	readonly stack: string;
	readonly live: boolean;
	readonly livePids: ReadonlyArray<number>;
	readonly shared: boolean;
	/** Discriminator for shared-resource groups. `'per-app-shared'`
	 *  groups (the `_per-app_` synthetic stack) stay pinned while any
	 *  sibling stack under the same app is live; `'router'` groups are
	 *  auto-prunable when no app pins them. `null` for normal groups. */
	readonly sharedKind: SharedGroupKind | null;
	/** True when the group represents a router-shared resource set that
	 *  is auto-prunable in non-interactive flows (`devstack prune --all`).
	 *  Computed by the orchestrator so surfaces never recompute the
	 *  router-stack naming predicate. */
	readonly autoPrunable: boolean;
	readonly containers: number;
	readonly runningContainers: number;
	readonly networks: number;
	readonly volumes: number;
	readonly images: number;
}

/** Kind of a shared-resource group. `'per-app-shared'` groups belong
 *  to the `PER_APP_SHARED_STACK` synthetic stack under a real app and
 *  stay pinned while a sibling stack is live. `'router'` groups are
 *  router-singleton resources. */
export type SharedGroupKind = 'per-app-shared' | 'router';

export interface LifecyclePruneInventory {
	readonly groups: ReadonlyArray<LifecyclePruneGroup>;
}

export interface LifecyclePruneResourceScope {
	readonly containers: boolean;
	readonly networks: boolean;
	readonly volumes: boolean;
	readonly images: boolean;
}

export interface LifecyclePruneSelection {
	readonly groupKeys: ReadonlyArray<string>;
	readonly resources: LifecyclePruneResourceScope;
	readonly dryRun: boolean;
}

export interface LifecyclePruneSummary {
	readonly inspectedGroups: number;
	readonly selectedGroups: number;
	readonly skippedLiveGroups: number;
	readonly containersRemoved: number;
	readonly networksRemoved: number;
	readonly networksSkipped: number;
	readonly volumesRemoved: number;
	readonly imagesRemoved: number;
	/** Non-devstack containers still holding networks that prune could
	 *  not remove. Empty when every network came down cleanly. */
	readonly foreignNetworkHolders: ReadonlyArray<ForeignNetworkHolder>;
	/** Endpoints Docker insists exist on a network but which no CLI/API
	 *  path can address — symptom of a Docker engine bug (the bridge
	 *  driver leaked endpoint metadata after a container was reaped).
	 *  Only a Docker daemon restart clears these. */
	readonly staleNetworkEndpoints: ReadonlyArray<StaleNetworkEndpoint>;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

type ResourceBucket = {
	containers: number;
	runningContainers: number;
	networks: number;
	volumes: number;
	images: number;
};

const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
	Layer.effect(
		DockerSpawner,
		Effect.gen(function* () {
			return yield* ChildProcessSpawner;
		}),
	);

const dockerLayer: Layer.Layer<DockerHost | DockerSpawner> = Layer.merge(
	layerDockerHostDefault,
	layerDockerSpawnerFromNode.pipe(
		Layer.provideMerge(
			NodeChildProcessSpawner.layer.pipe(
				Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
			),
		),
	),
);

const emptyBucket = (): ResourceBucket => ({
	containers: 0,
	runningContainers: 0,
	networks: 0,
	volumes: 0,
	images: 0,
});

/** Public, parser-safe key for a `(app, stack)` group. Display-only —
 *  internal grouping uses the structural `{app, stack}` tuple via the
 *  `GroupBuckets` map below, so a slash inside `app` or `stack` cannot
 *  produce a wrong tuple. The separator is a forward slash for human-
 *  readable log/JSON output (`arena/main`); membership tests round-trip
 *  through this same constructor so callers never re-split the key —
 *  any potential `/`-in-app-or-stack ambiguity is resolved structurally
 *  by `GroupBuckets`, not by string-splitting the key. */
const GROUP_KEY_SEPARATOR = '/';

export const lifecyclePruneGroupKey = (app: string, stack: string): string =>
	`${app}${GROUP_KEY_SEPARATOR}${stack}`;

/** Map keyed on `(app, stack)` tuples without string encoding. Tuple
 *  equality is achieved by interning each `(app, stack)` pair through
 *  a nested `app → stack → bucket` index, so the map is collision-
 *  free even when `app` or `stack` contains a separator character. */
class GroupBuckets {
	private readonly buckets = new Map<string, Map<string, ResourceBucket>>();

	get(identity: { readonly app: string; readonly stack: string }): ResourceBucket {
		let perApp = this.buckets.get(identity.app);
		if (perApp === undefined) {
			perApp = new Map<string, ResourceBucket>();
			this.buckets.set(identity.app, perApp);
		}
		let bucket = perApp.get(identity.stack);
		if (bucket === undefined) {
			bucket = emptyBucket();
			perApp.set(identity.stack, bucket);
		}
		return bucket;
	}

	*entries(): Iterable<{
		readonly app: string;
		readonly stack: string;
		readonly bucket: ResourceBucket;
	}> {
		for (const [app, perApp] of this.buckets) {
			for (const [stack, bucket] of perApp) {
				yield { app, stack, bucket };
			}
		}
	}
}

const readAppStack = (
	labels: Readonly<Record<string, string>>,
): { readonly app: string; readonly stack: string } | null => {
	const app = labels[LabelKey.app];
	const stack = labels[LabelKey.stack];
	if (app === undefined || app.length === 0) return null;
	if (stack === undefined || stack.length === 0) return null;
	return { app, stack };
};

const routerStackForContainer = (
	name: string,
): { readonly app: string; readonly stack: string } => ({
	app: ROUTER_SHARED_APP,
	stack: name,
});

const livePidsForStack = (
	runtimeRoot: string,
	stack: string,
): Effect.Effect<ReadonlyArray<number>> => {
	const rosterFile = joinPath(runtimeRoot, 'stacks', stack, 'roster.json');
	if (!existsSync(rosterFile)) return Effect.succeed([]);
	// Yield a fresh `LivenessProbeScope` so a recycled-PID corner case
	// (multiple holders sharing one pid in the same roster) forks the OS
	// liveness probe once per pid across this scan.
	return Effect.gen(function* () {
		const doc = yield* readRoster(rosterFile).pipe(
			logDebugAndFallback(null, 'lifecycle-prune: roster read failed; treating as empty', {
				rosterFile,
			}),
		);
		if (doc === null) return [];
		const probe = yield* LivenessProbeScope;
		const pids: Array<number> = [];
		for (const holder of doc.holders) {
			const live = yield* probe
				.probeHolderLiveness(holder)
				.pipe(
					logDebugAndFallback(
						'alive' as const,
						'lifecycle-prune: liveness check failed; assuming alive',
						{ pid: holder.pid },
					),
				);
			if (live === 'alive') pids.push(holder.pid);
		}
		return pids;
	}).pipe(Effect.provide(layerLivenessProbeScope));
};

/** True when the group is one of the two shared shapes the
 *  orchestrator knows about: `_per-app_` (cross-stack-per-app shared)
 *  or the router-singleton (`ROUTER_SHARED_APP`). Surfaces consult
 *  this instead of recomputing the predicate. */
export const isSharedLifecyclePruneGroup = (app: string, stack: string): boolean =>
	stack === PER_APP_SHARED_STACK || app === ROUTER_SHARED_APP;

const sharedKindFor = (app: string, stack: string): SharedGroupKind | null => {
	if (app === ROUTER_SHARED_APP) return 'router';
	if (stack === PER_APP_SHARED_STACK) return 'per-app-shared';
	return null;
};

/** True when the group represents a router-singleton resource set.
 *  Exported so L4 surfaces can call this rather than re-implement the
 *  router-stack naming predicate. */
export const isRouterLifecyclePruneGroup = (
	group: Pick<LifecyclePruneGroup, 'app' | 'stack'>,
): boolean =>
	group.app === ROUTER_SHARED_APP && group.stack.startsWith(`${ROUTER_SHARED_APP}-`);

// Internal aliases for back-compat call sites in this file.
const isRouterGroup = isRouterLifecyclePruneGroup;
const isSharedGroup = isSharedLifecyclePruneGroup;

/** Label-tuple match for the `removeDevstack*` sweepers — router-shared
 *  resources stamp `{app: ROUTER_SHARED_APP, stack: <profile-name>}`
 *  (see `traefik-container.ts:ensureNetwork`) and the inventory pass
 *  buckets them under `routerStackForContainer(container.name)`, so for
 *  router groups the tuple is `{app: ROUTER_SHARED_APP, stack: group.stack}`.
 *  For non-router groups it's the bucket's literal `{app, stack}`. The
 *  branch is structurally identical to the container-removal branch's
 *  router-specific dispatch via `removeDevstackContainersByKindAndName`,
 *  so dry-run inventory counts and real-run removal stay in lockstep
 *  for router resources. Exported so tests can pin the dry-run ↔
 *  real-run parity without standing up a Docker daemon. */
export const lifecyclePruneRemovalMatchTuple = (
	group: Pick<LifecyclePruneGroup, 'app' | 'stack'>,
): { readonly app: string; readonly stack: string } =>
	isRouterGroup(group)
		? { app: ROUTER_SHARED_APP, stack: group.stack }
		: { app: group.app, stack: group.stack };

const matchTupleForGroup = lifecyclePruneRemovalMatchTuple;

// -----------------------------------------------------------------------------
// Orchestrator entry points
// -----------------------------------------------------------------------------

export const collectLifecyclePruneInventory = (
	options: LifecyclePruneOptions,
): Effect.Effect<LifecyclePruneInventory, LifecyclePruneError> =>
	Effect.gen(function* () {
		const [containers, routerContainers, networks, volumes, images] = yield* Effect.all(
			[
				listDevstackContainers(),
				listDevstackContainersByKind(ROUTER_KIND_LABEL_VALUE),
				listDevstackNetworks(),
				listDevstackVolumes(),
				listDevstackImages(),
			],
			{ concurrency: 'unbounded' },
		).pipe(Effect.provide(dockerLayer), Effect.mapError(failPhase('inventory')));

		const buckets = new GroupBuckets();

		for (const container of containers) {
			const identity = readAppStack(container.labels);
			if (identity === null) continue;
			const bucket = buckets.get(identity);
			bucket.containers += 1;
			if (container.state === 'running') bucket.runningContainers += 1;
		}
		for (const container of routerContainers) {
			const bucket = buckets.get(routerStackForContainer(container.name));
			bucket.containers += 1;
			if (container.state === 'running') bucket.runningContainers += 1;
		}
		for (const network of networks) {
			const identity = readAppStack(network.labels);
			if (identity === null) continue;
			buckets.get(identity).networks += 1;
		}
		for (const volume of volumes) {
			const identity = readAppStack(volume.labels);
			if (identity === null) continue;
			buckets.get(identity).volumes += 1;
		}
		for (const image of images) {
			const identity = readAppStack(image.labels);
			if (identity === null) continue;
			buckets.get(identity).images += 1;
		}

		const groups: Array<LifecyclePruneGroup> = [];
		for (const entry of buckets.entries()) {
			const { app, stack, bucket } = entry;
			const routerGroup = app === ROUTER_SHARED_APP;
			const livePids = routerGroup ? [] : yield* livePidsForStack(options.runtimeRoot, stack);
			groups.push({
				key: lifecyclePruneGroupKey(app, stack),
				app,
				stack,
				live: routerGroup ? bucket.runningContainers > 0 : livePids.length > 0,
				livePids,
				shared: isSharedGroup(app, stack),
				sharedKind: sharedKindFor(app, stack),
				autoPrunable: isRouterGroup({ app, stack }),
				containers: bucket.containers,
				runningContainers: bucket.runningContainers,
				networks: bucket.networks,
				volumes: bucket.volumes,
				images: bucket.images,
			});
		}

		groups.sort((a, b) => {
			if (a.app !== b.app) return a.app < b.app ? -1 : 1;
			return a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0;
		});

		return { groups };
	}).pipe(Effect.withSpan('orchestrator.lifecycle-prune.inventory'));

const selectedGroups = (
	inventory: LifecyclePruneInventory,
	selection: LifecyclePruneSelection,
): ReadonlyArray<LifecyclePruneGroup> => {
	const selected = new Set(selection.groupKeys);
	return inventory.groups.filter((group) => selected.has(group.key));
};

/** Default resource scope for the lifecycle-prune orchestrator —
 *  containers + networks + volumes, never images. Surfaces consume
 *  this directly so the default never drifts between L3 and L4. */
export const DEFAULT_LIFECYCLE_PRUNE_RESOURCES: LifecyclePruneResourceScope = {
	containers: true,
	networks: true,
	volumes: true,
	images: false,
};

/** Apps with at least one live non-shared group — their `_per-app_`
 *  shared resources stay pinned because something under the app is
 *  still running. Exported so L4 surfaces consume the orchestrator's
 *  pinning predicate. */
export const lifecyclePruneAppsWithLiveSiblings = (
	inventory: LifecyclePruneInventory,
): ReadonlySet<string> => {
	const apps = new Set<string>();
	for (const group of inventory.groups) {
		if (!group.shared && group.live) apps.add(group.app);
	}
	return apps;
};

const groupHasResource = (
	group: LifecyclePruneGroup,
	resources: LifecyclePruneResourceScope,
): boolean =>
	(resources.containers && group.containers > 0) ||
	(resources.networks && group.networks > 0) ||
	(resources.volumes && group.volumes > 0) ||
	(resources.images && group.images > 0);

/** Default selection: every non-live group whose shared shape is
 *  prunable in non-interactive flows. Surfaces and the live-supervisor
 *  command handler share this so the orchestrator owns the policy. */
export const defaultLifecyclePruneSelection = (
	inventory: LifecyclePruneInventory,
	resources: LifecyclePruneResourceScope = DEFAULT_LIFECYCLE_PRUNE_RESOURCES,
): ReadonlyArray<string> => {
	const pinned = lifecyclePruneAppsWithLiveSiblings(inventory);
	const keys: string[] = [];
	for (const group of inventory.groups) {
		if (group.live) continue;
		if (!groupHasResource(group, resources)) continue;
		if (group.sharedKind === 'per-app-shared' && pinned.has(group.app)) continue;
		if (group.shared && !group.autoPrunable && group.sharedKind !== 'per-app-shared') continue;
		keys.push(group.key);
	}
	return keys;
};

export const runLifecyclePrune = (
	options: LifecyclePruneOptions,
	selection: LifecyclePruneSelection,
): Effect.Effect<LifecyclePruneSummary, LifecyclePruneError> =>
	Effect.gen(function* () {
		const inventory = yield* collectLifecyclePruneInventory(options);
		const groups = selectedGroups(inventory, selection);
		let skippedLiveGroups = 0;
		let containersRemoved = 0;
		let networksRemoved = 0;
		let networksSkipped = 0;
		let volumesRemoved = 0;
		let imagesRemoved = 0;

		const prunableGroups: Array<LifecyclePruneGroup> = [];
		for (const group of groups) {
			if (group.live) {
				skippedLiveGroups += 1;
				continue;
			}
			prunableGroups.push(group);
			if (selection.dryRun) {
				if (selection.resources.containers) containersRemoved += group.containers;
				if (selection.resources.networks) networksRemoved += group.networks;
				if (selection.resources.volumes) volumesRemoved += group.volumes;
				if (selection.resources.images) imagesRemoved += group.images;
				continue;
			}
		}

		if (!selection.dryRun && selection.resources.containers) {
			for (const group of prunableGroups) {
				if (isRouterGroup(group)) {
					containersRemoved += yield* removeDevstackContainersByKindAndName(
						ROUTER_KIND_LABEL_VALUE,
						group.stack,
					).pipe(Effect.provide(dockerLayer), Effect.mapError(failPhase('remove-containers')));
				} else {
					const match = { app: group.app, stack: group.stack };
					containersRemoved += yield* removeDevstackContainers(match).pipe(
						Effect.provide(dockerLayer),
						Effect.mapError(failPhase('remove-containers')),
					);
				}
			}
		}

		const foreignNetworkHolders: Array<ForeignNetworkHolder> = [];
		const staleNetworkEndpoints: Array<StaleNetworkEndpoint> = [];
		if (!selection.dryRun && selection.resources.networks) {
			for (const group of prunableGroups) {
				const match = matchTupleForGroup(group);
				const result = yield* removeDevstackNetworksBestEffort(match).pipe(
					Effect.provide(dockerLayer),
					Effect.mapError(failPhase('remove-networks')),
				);
				networksRemoved += result.removed;
				networksSkipped += result.skippedInUse;
				for (const holder of result.foreignHolders) foreignNetworkHolders.push(holder);
				for (const ep of result.staleEndpoints) staleNetworkEndpoints.push(ep);
			}
		}

		if (!selection.dryRun && selection.resources.volumes) {
			for (const group of prunableGroups) {
				const match = matchTupleForGroup(group);
				volumesRemoved += yield* removeDevstackVolumes(match).pipe(
					Effect.provide(dockerLayer),
					Effect.mapError(failPhase('remove-volumes')),
				);
			}
		}

		if (!selection.dryRun && selection.resources.images) {
			for (const group of prunableGroups) {
				const match = matchTupleForGroup(group);
				imagesRemoved += yield* removeDevstackImages(match).pipe(
					Effect.provide(dockerLayer),
					Effect.mapError(failPhase('remove-images')),
				);
			}
		}

		if (!selection.dryRun) {
			yield* Effect.gen(function* () {
				for (const group of prunableGroups) {
					if (!isRouterGroup(group)) continue;
					yield* removeRouterProfileStateForDockerStack({
						runtimeRoot: options.runtimeRoot,
						routerStack: group.stack,
					});
				}
			}).pipe(
				Effect.provide(NodeFileSystem.layer),
				Effect.withSpan('orchestrator.lifecycle-prune.removeRouterProfileState'),
			);
		}

		return {
			inspectedGroups: groups.length,
			selectedGroups: groups.length,
			skippedLiveGroups,
			containersRemoved,
			networksRemoved,
			networksSkipped,
			volumesRemoved,
			imagesRemoved,
			foreignNetworkHolders,
			staleNetworkEndpoints,
		};
	}).pipe(Effect.withSpan('orchestrator.lifecycle-prune.run'));
