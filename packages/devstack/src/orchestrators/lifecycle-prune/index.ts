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
	LabelKey,
	layerDockerHostDefault,
	listDevstackContainers,
	listDevstackImages,
	listDevstackNetworks,
	listDevstackRouterContainers,
	listDevstackVolumes,
	removeDevstackContainers,
	removeDevstackImages,
	removeDevstackNetworksBestEffort,
	removeDevstackRouterContainers,
	removeDevstackVolumes,
} from '../../runtime/docker/index.ts';
import { checkHolderLiveness, readRoster } from '../../substrate/runtime/cross-process/index.ts';
import {
	ROUTER_SHARED_APP,
	removeRouterProfileStateForDockerStack,
} from '../router/cleanup.ts';

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

const groupKey = (app: string, stack: string): string => `${app}/${stack}`;

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

const addBucket = (
	buckets: Map<string, ResourceBucket>,
	identity: { readonly app: string; readonly stack: string },
): ResourceBucket => {
	const key = groupKey(identity.app, identity.stack);
	let bucket = buckets.get(key);
	if (bucket === undefined) {
		bucket = emptyBucket();
		buckets.set(key, bucket);
	}
	return bucket;
};

const livePidsForStack = (
	runtimeRoot: string,
	stack: string,
): Effect.Effect<ReadonlyArray<number>> => {
	const rosterFile = joinPath(runtimeRoot, 'stacks', stack, 'roster.json');
	if (!existsSync(rosterFile)) return Effect.succeed([]);
	return Effect.gen(function* () {
		const doc = yield* readRoster(rosterFile).pipe(Effect.catch(() => Effect.succeed(null)));
		if (doc === null) return [];
		const pids: Array<number> = [];
		for (const holder of doc.holders) {
			const live = yield* checkHolderLiveness(holder).pipe(
				Effect.catch(() => Effect.succeed('alive' as const)),
			);
			if (live === 'alive') pids.push(holder.pid);
		}
		return pids;
	});
};

const isSharedGroup = (app: string, stack: string): boolean =>
	stack === '_per-app_' || app === ROUTER_SHARED_APP;

const isRouterGroup = (group: Pick<LifecyclePruneGroup, 'app' | 'stack'>): boolean =>
	group.app === ROUTER_SHARED_APP && group.stack.startsWith(`${ROUTER_SHARED_APP}-`);

// -----------------------------------------------------------------------------
// Orchestrator entry points
// -----------------------------------------------------------------------------

export const collectLifecyclePruneInventory = (
	options: LifecyclePruneOptions,
): Effect.Effect<LifecyclePruneInventory, unknown> =>
	Effect.gen(function* () {
		const [containers, routerContainers, networks, volumes, images] = yield* Effect.all(
			[
				listDevstackContainers(),
				listDevstackRouterContainers(),
				listDevstackNetworks(),
				listDevstackVolumes(),
				listDevstackImages(),
			],
			{ concurrency: 'unbounded' },
		).pipe(Effect.provide(dockerLayer));

		const buckets = new Map<string, ResourceBucket>();

		for (const container of containers) {
			const identity = readAppStack(container.labels);
			if (identity === null) continue;
			const bucket = addBucket(buckets, identity);
			bucket.containers += 1;
			if (container.state === 'running') bucket.runningContainers += 1;
		}
		for (const container of routerContainers) {
			const bucket = addBucket(buckets, routerStackForContainer(container.name));
			bucket.containers += 1;
			if (container.state === 'running') bucket.runningContainers += 1;
		}
		for (const network of networks) {
			const identity = readAppStack(network.labels);
			if (identity === null) continue;
			addBucket(buckets, identity).networks += 1;
		}
		for (const volume of volumes) {
			const identity = readAppStack(volume.labels);
			if (identity === null) continue;
			addBucket(buckets, identity).volumes += 1;
		}
		for (const image of images) {
			const identity = readAppStack(image.labels);
			if (identity === null) continue;
			addBucket(buckets, identity).images += 1;
		}

		const groups: Array<LifecyclePruneGroup> = [];
		for (const [key, bucket] of buckets) {
			const [app, stack] = key.split('/') as [string, string];
			const routerGroup = app === ROUTER_SHARED_APP;
			const livePids = routerGroup ? [] : yield* livePidsForStack(options.runtimeRoot, stack);
			groups.push({
				key,
				app,
				stack,
				live: routerGroup ? bucket.runningContainers > 0 : livePids.length > 0,
				livePids,
				shared: isSharedGroup(app, stack),
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

export const runLifecyclePrune = (
	options: LifecyclePruneOptions,
	selection: LifecyclePruneSelection,
): Effect.Effect<LifecyclePruneSummary, unknown> =>
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
					containersRemoved += yield* removeDevstackRouterContainers(group.stack).pipe(
						Effect.provide(dockerLayer),
					);
				} else {
					const match = { app: group.app, stack: group.stack };
					containersRemoved += yield* removeDevstackContainers(match).pipe(
						Effect.provide(dockerLayer),
					);
				}
			}
		}

		if (!selection.dryRun && selection.resources.networks) {
			for (const group of prunableGroups) {
				const match = { app: group.app, stack: group.stack };
				const result = yield* removeDevstackNetworksBestEffort(match).pipe(
					Effect.provide(dockerLayer),
				);
				networksRemoved += result.removed;
				networksSkipped += result.skippedInUse;
			}
		}

		if (!selection.dryRun && selection.resources.volumes) {
			for (const group of prunableGroups) {
				const match = { app: group.app, stack: group.stack };
				volumesRemoved += yield* removeDevstackVolumes(match).pipe(Effect.provide(dockerLayer));
			}
		}

		if (!selection.dryRun && selection.resources.images) {
			for (const group of prunableGroups) {
				const match = { app: group.app, stack: group.stack };
				imagesRemoved += yield* removeDevstackImages(match).pipe(Effect.provide(dockerLayer));
			}
		}

		if (!selection.dryRun) {
			for (const group of prunableGroups) {
				if (!isRouterGroup(group)) continue;
				yield* removeRouterProfileStateForDockerStack({
					runtimeRoot: options.runtimeRoot,
					routerStack: group.stack,
				});
			}
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
		};
	}).pipe(Effect.withSpan('orchestrator.lifecycle-prune.run'));
