// `walrusLocalCluster()` — full local boot. Builds the wrapper image,
// deploys contracts on local sui, registers nodes, fronts them via
// nginx, funds seed accounts. Provides all four narrow interfaces
// (`WalrusNetwork`, `WalrusNodes`, `WalrusProxy`, `WalrusAdmin`).
//
// Acquire-phase mechanics (image build → deploy one-shot → node
// committee → exchange discovery → nginx proxy → seed-account swap)
// live in `./internal.ts`; this file owns the factory wiring + the
// single `Layer.effectContext` that projects the acquire state across
// all four interface keys.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, Effect, Layer } from 'effect';
import type { StackMember } from '../../engine/supervisor.js';
import {
	WalrusAdmin,
	WalrusNetwork,
	WalrusNodes,
	WalrusProxy,
	type WalrusAdminShape,
	type WalrusNetworkShape,
	type WalrusNodeInfo,
	type WalrusNodesShape,
	type WalrusProxyShape,
} from '../../interfaces/walrus.js';
import { dockerImage, gitFetch } from '../../advanced/plugin-author/index.js';
import { composeLayers, type PluginTag } from '../../advanced/tag.js';
import { WalrusError } from '../errors.js';
import type { Account } from '../shared.js';
import {
	acquireLocalCluster,
	DEFAULT_EPOCH_DURATION,
	DEFAULT_NODE_API_PORT,
	DEFAULT_READY_TIMEOUT_MS,
	DEFAULT_RUST_TOOLCHAIN,
	DEFAULT_SEED_WAL_PAYMENT_MIST,
	DEFAULT_SHARDS,
	DEFAULT_SUI_VERSION,
	DEFAULT_WALRUS_MOVE_SUBDIR,
	DEFAULT_WALRUS_REF,
	DEFAULT_WALRUS_REPO,
	EngineHandle,
	LOCAL_CLUSTER_KEY,
	makeAdminShape,
} from './internal.js';

export interface WalrusLocalClusterOptions<Name extends string = 'walrus'> {
	readonly name?: Name;
	readonly nodeCount?: number;
	readonly seedAccounts?: ReadonlyArray<PluginTag<any, Account, any, any>>;
	/**
	 * @deprecated No longer honored. The shared Traefik router binds
	 * the walrus entrypoint port (9185) once on the host and routes by
	 * `Host:` header to each per-stack backend, so there is no per-
	 * stack proxy port to allocate. Kept on the options shape for
	 * back-compat; callers can safely drop it.
	 */
	readonly proxyPort?: number;
	/** Pinned walrus release tag. Drives both the `git clone --branch` in
	 *  the upstream Dockerfile and the matching Move-source fetch.
	 *  Default `walrus-v1.39.0`. */
	readonly version?: string;
	/** Sui release whose binary the wrapper image bakes for the deploy
	 *  script's admin-wallet bootstrap. Default `devnet-v1.71.0`. */
	readonly suiVersion?: string;
	/** Container API port each storage node binds. Default 9185 (v3 default). */
	readonly containerApiPort?: number;
	/** Shards distributed across the committee. Must be >= nodeCount. */
	readonly shards?: number;
	/** Walrus epoch duration. Default `'24h'`. */
	readonly epochDuration?: string;
	/** Per-node ready probe timeout. Default 60s. */
	readonly readyTimeoutMs?: number;
	/** SUI to swap into WAL on each seed account, in MIST. Default 0.5 SUI. */
	readonly seedPaymentMist?: bigint;
	/** Optional path to a vendored `walrus/move/walrus` checkout. When
	 *  omitted, the primitive `gitFetch`es the upstream source at a
	 *  pinned ref. */
	readonly movePackagePath?: string;
}

export const walrusLocalCluster = <const Name extends string = 'walrus'>(
	options: WalrusLocalClusterOptions<Name> = {},
): StackMember => {
	const name = (options.name ?? 'walrus') as Name;
	const nodeCount = options.nodeCount ?? 1;
	const containerApiPort = options.containerApiPort ?? DEFAULT_NODE_API_PORT;
	const shards = options.shards ?? DEFAULT_SHARDS;
	const epochDuration = options.epochDuration ?? DEFAULT_EPOCH_DURATION;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const seedPaymentMist = options.seedPaymentMist ?? DEFAULT_SEED_WAL_PAYMENT_MIST;

	if (nodeCount < 1) {
		throw new Error('walrusLocalCluster: nodeCount must be at least 1');
	}
	if (shards < nodeCount) {
		throw new Error(`walrusLocalCluster: shards (${shards}) must be >= nodeCount (${nodeCount})`);
	}

	const walrusVersion = options.version ?? DEFAULT_WALRUS_REF;
	const suiVersion = options.suiVersion ?? DEFAULT_SUI_VERSION;

	// Resolve each seed-account tag upfront so the type-checker treats
	// the array as a tuple — yield* inside the build pulls each
	// `Account` shape so we can submit per-account seed txs.
	const seedAccountTags = options.seedAccounts ?? [];

	// Sibling tag for the Move source fetch. Built at factory time so its
	// layer surfaces via `__layers` and defineDevstack provides the deps
	// (FileSystem + ChildProcessSpawner) at runtime. Skipped entirely
	// when the caller vendors a path themselves.
	const moveSource =
		options.movePackagePath === undefined
			? gitFetch({
					name: `${name}.move-source` as const,
					repo: DEFAULT_WALRUS_REPO,
					ref: walrusVersion,
					subdirectory: DEFAULT_WALRUS_MOVE_SUBDIR,
				})
			: undefined;

	// Sibling tag for the upstream walrus image (cargo-built binaries).
	// Built at factory time so its layer surfaces via `__layers` and
	// defineDevstack provides the deps (`ChildProcessSpawner`) at
	// runtime. The wrapper image is built _inline_ inside the body
	// because its `BASE_IMAGE` build-arg depends on the upstream's
	// runtime-resolved content-addressed tag, which only exists after
	// the upstream tag's body has run.
	const dockerContext = new URL('../../../walrus-image/', import.meta.url).pathname;
	const upstreamImage = dockerImage({
		name: `${name}.image.upstream` as const,
		build: {
			context: dockerContext,
			dockerfile: 'upstream.Dockerfile',
			buildArgs: {
				WALRUS_VERSION: walrusVersion,
				WALRUS_REPO: DEFAULT_WALRUS_REPO,
				RUST_TOOLCHAIN: DEFAULT_RUST_TOOLCHAIN,
				GIT_REVISION: walrusVersion,
			},
		},
	});

	// Single acquire-and-project Effect. Runs the full boot once, then
	// returns a Context populated with all four interface keys plus the
	// legacy `Walrus` aggregate so a single `Layer.effectContext` covers
	// every consumer shape downstream code might reach for.
	const acquireAndProject = Effect.fn(`walrusLocalCluster(${name})`)(function* () {
		// Engine lifecycle is wired manually here rather than through
		// `provideTag` because we're producing a multi-service Context
		// from a single body. `EngineHandle` is satisfied by InfraLive
		// at run time; when run outside a devstack (e.g. a unit test
		// providing only this layer) we degrade to a noop.
		const engineOpt = yield* Effect.serviceOption(EngineHandle);
		const startup =
			engineOpt._tag === 'Some'
				? Effect.gen(function* () {
						yield* engineOpt.value.markAcquiring(LOCAL_CLUSTER_KEY, 'service');
						yield* engineOpt.value.setEntryTitle(LOCAL_CLUSTER_KEY, 'walrus.cluster');
					})
				: Effect.void;
		yield* startup;

		// Forward setPhase narration onto the engine entry. The acquire
		// body doesn't go through `withEngineLifecycle` (it produces a
		// multi-service Context, not a single tag), so we hand it a
		// callback that no-ops outside an engine and pushes into the
		// LOCAL_CLUSTER_KEY entry otherwise.
		const pushPhase = (phase: string): Effect.Effect<void> =>
			engineOpt._tag === 'Some'
				? engineOpt.value.setPhase(LOCAL_CLUSTER_KEY, phase)
				: Effect.void;

		const acquired = yield* acquireLocalCluster({
			name,
			nodeCount,
			containerApiPort,
			shards,
			epochDuration,
			readyTimeoutMs,
			seedPaymentMist,
			walrusVersion,
			suiVersion,
			dockerContext,
			upstreamImage: upstreamImage as PluginTag<any, any, any, any>,
			moveSource: moveSource as PluginTag<any, any, any, any> | undefined,
			movePackagePath: options.movePackagePath,
			seedAccountTags,
			pushPhase,
		}).pipe(
			Effect.tapCause((cause) =>
				engineOpt._tag === 'Some'
					? engineOpt.value.markFailed(LOCAL_CLUSTER_KEY, cause)
					: Effect.void,
			),
		);

		if (engineOpt._tag === 'Some') {
			yield* engineOpt.value.markReady(LOCAL_CLUSTER_KEY, {
				title: 'walrus.cluster',
				primary: acquired.proxyUrl,
				extras: [`${acquired.nodes.length} node${acquired.nodes.length === 1 ? '' : 's'}`],
			});
		}

		const exchangeIds =
			acquired.deploy.exchangeObject !== undefined
				? [acquired.deploy.exchangeObject]
				: undefined;
		const networkShape: WalrusNetworkShape = {
			systemObjectId: acquired.deploy.systemObject,
			stakingPoolId: acquired.deploy.stakingObject,
			subsidiesPackageId: undefined,
			exchangeIds,
			network: 'localnet',
			// SDK-ready view. Pass directly to `new WalrusClient({
			// suiClient, packageConfig })` — the shape mirrors
			// `WalrusPackageConfig` so the upstream SDK's package
			// resolution (system-object type query) just works against
			// the local deploy.
			packageConfig: {
				systemObjectId: acquired.deploy.systemObject,
				stakingPoolId: acquired.deploy.stakingObject,
				...(exchangeIds !== undefined ? { exchangeIds } : {}),
			},
		};

		// Local nodes don't surface a registered `nodeId` or `publicKey`
		// today — the upstream `deploy-system-contract` writes only the
		// committee size + chain ids into the deploy summary, not the
		// per-node BLS keys. Stable synthetic ids let `WalrusNodesShape`
		// stay honest about what we can observe; future work could read
		// the `staking_pool` object on chain to fill these in.
		const nodesShape: WalrusNodesShape = {
			nodes: acquired.nodes.map(
				(n): WalrusNodeInfo => ({
					nodeId: `walrus-node-${n.index}`,
					publicKey: '',
					url: n.rpcUrl,
				}),
			),
		};

		const proxyShape: WalrusProxyShape = {
			proxyUrl: acquired.proxyUrl,
			aggregatorUrl: acquired.proxyUrl,
			publisherUrl: acquired.proxyUrl,
		};

		const adminShape: WalrusAdminShape = makeAdminShape({
			nodes: acquired.nodes,
			exchange: acquired.exchange,
			defaultSeedPaymentMist: acquired.seedPaymentMist,
			seedAccountsByAddress: new Map(acquired.seedAccounts.map((a) => [a.address, a] as const)),
		});

		return Context.make(WalrusNetwork, networkShape).pipe(
			Context.add(WalrusNodes, nodesShape),
			Context.add(WalrusProxy, proxyShape),
			Context.add(WalrusAdmin, adminShape),
		);
	})();

	const combinedLayer = Layer.effectContext(acquireAndProject) as Layer.Layer<
		WalrusNetwork | WalrusNodes | WalrusProxy | WalrusAdmin,
		WalrusError,
		any
	>;

	// `composeLayers` lays out `inner → primary → projections` so the
	// fold in `composeStackLayer` finds each layer's deps already
	// satisfied. `combinedLayer` yields `moveSource` and `upstreamImage`
	// inside its body, so it goes after them as `primary`. No projections
	// here — the four interface tags resolve from a single
	// `Layer.effectContext`.
	return {
		__layer: combinedLayer,
		__layers: composeLayers({
			inner: [upstreamImage, moveSource],
			primary: combinedLayer,
		}),
		key: LOCAL_CLUSTER_KEY,
		__kind: 'service' as const,
		__displayTitle: 'walrus.cluster',
	};
};
