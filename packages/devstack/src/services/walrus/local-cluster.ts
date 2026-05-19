// `walrusLocalCluster()` — full local boot. Builds the wrapper image,
// deploys contracts on local sui, registers nodes, fronts them via
// nginx, funds seed accounts. Provides all four narrow interfaces
// (`WalrusNetworkTag`, `WalrusNodesTag`, `WalrusProxyTag`, `WalrusAdminTag`).
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
	WalrusAdminTag,
	WalrusNetworkTag,
	WalrusNodesTag,
	WalrusProxyTag,
	type WalrusAdmin,
	type WalrusNetwork,
	type WalrusNodeInfo,
	type WalrusNodes,
	type WalrusProxy,
} from '../walrus.js';
import { dockerImage, gitFetch } from '../../advanced/plugin-author/index.js';
import { type LayeredTag } from '../../advanced/tag.js';
import { ForkIncompatibleError, WalrusError } from '../../engine/errors.js';
import { resolveNetwork } from '../../engine/network.js';
import type { Account } from '../../engine/shared.js';
import { SuiTag } from '../sui.js';
import { resolveUpstreamKeys } from '../../advanced/tag.js';
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
	readonly seedAccounts?: ReadonlyArray<LayeredTag<any, Account, any, any>>;
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

	// D5 / Phase 3 P3.5: walrusLocalCluster needs JSON-RPC against the
	// wrapped chain, which sui-fork does not expose. Phase 5 P5.1 audit
	// (finalised 2026-05-19, `notes/sui-fork-phase-5-walrus-seal-audit.md`
	// §1) confirmed that upstream walrus's `DualClient`
	// (`crates/walrus-sui/src/client/dual_client.rs`) still has ~12
	// load-bearing JSON-RPC callsites on `read_api()` / `coin_read_api()` /
	// `event_api()` — the gRPC migration is in-flight, not complete. The
	// original plan's "GraphQL shim" framing doesn't match the upstream
	// surface (walrus uses no GraphQL anywhere), so the unblock is
	// upstream-tracked rather than devstack-implementable. Composing this
	// variant on a fork stack would let the supervisor partway through
	// image build before the cluster's storage nodes fail to dial the
	// chain — fail fast at factory time instead so the structured error
	// names the known-deployment alternative.
	const resolvedNetwork = resolveNetwork();
	if (resolvedNetwork.endsWith('-fork')) {
		throw new ForkIncompatibleError({
			variant: 'walrusLocalCluster',
			network: resolvedNetwork,
			message:
				`walrusLocalCluster is incompatible with fork mode (${resolvedNetwork}) — ` +
				`the local cluster's storage nodes need JSON-RPC against the wrapped ` +
				`chain, which sui-fork does not expose. Use \`Walrus()\` (which auto-routes to ` +
				`the known-deployment branch in fork mode) or \`walrusKnownDeployment({network})\` ` +
				`directly, pointing at the wrapped upstream.`,
			hint: `replace walrusLocalCluster() with Walrus() or walrusKnownDeployment({network: '${resolvedNetwork.replace('-fork', '')}'})`,
		});
	}

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
	const dockerContext = new URL('../../../images/walrus/', import.meta.url).pathname;
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
	//
	// Lifecycle (Phase 2 of selective-restart): the ambient `Scope.Scope`
	// is this composite tag's own primitive scope — Effect's MemoMap
	// forks one scope per Layer.effect. Docker.run finalizers inside
	// `acquireLocalCluster` (storage nodes, nginx proxy, deploy one-shot,
	// network) attach to that scope automatically. `r` (full rebuild)
	// cascades through the supervisor's outer scope and releases every
	// primitive; a targeted watch-fire only releases the primitives in
	// the affected closure via `engine.invalidateSubset`.
	const acquireAndProject = Effect.fn(`walrusLocalCluster(${name})`)(function* () {
		// Engine lifecycle is wired manually here rather than through
		// `provide` because we're producing a multi-service Context
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
			engineOpt._tag === 'Some' ? engineOpt.value.setPhase(LOCAL_CLUSTER_KEY, phase) : Effect.void;

		const acquireEffect = acquireLocalCluster({
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
			upstreamImage: upstreamImage as LayeredTag<any, any, any, any>,
			moveSource: moveSource as LayeredTag<any, any, any, any> | undefined,
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
		// Run the acquire under this composite tag's primitive scope —
		// Docker.run finalizers attach to it automatically, and selective
		// invalidation releases just this scope when walrus is in the
		// affected set.
		const acquired = yield* acquireEffect;

		if (engineOpt._tag === 'Some') {
			yield* engineOpt.value.markReady(LOCAL_CLUSTER_KEY, {
				title: 'walrus.cluster',
				primary: acquired.proxyUrl,
				extras: [`${acquired.nodes.length} node${acquired.nodes.length === 1 ? '' : 's'}`],
			});
		}

		const exchangeIds =
			acquired.deploy.exchangeObject !== undefined ? [acquired.deploy.exchangeObject] : undefined;
		const networkShape: WalrusNetwork = {
			systemObjectId: acquired.deploy.systemObject,
			stakingPoolId: acquired.deploy.stakingObject,
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
		// per-node BLS keys. Stable synthetic ids let `WalrusNodes`
		// stay honest about what we can observe; future work could read
		// the `staking_pool` object on chain to fill these in.
		const nodesShape: WalrusNodes = {
			nodes: acquired.nodes.map(
				(n): WalrusNodeInfo => ({
					nodeId: `walrus-node-${n.index}`,
					publicKey: '',
					url: n.rpcUrl,
				}),
			),
		};

		const proxyShape: WalrusProxy = {
			proxyUrl: acquired.proxyUrl,
			aggregatorUrl: acquired.proxyUrl,
			publisherUrl: acquired.proxyUrl,
		};

		const adminShape: WalrusAdmin = makeAdminShape({
			nodes: acquired.nodes,
			exchange: acquired.exchange,
			defaultSeedPaymentMist: acquired.seedPaymentMist,
			seedAccountsByAddress: new Map(acquired.seedAccounts.map((a) => [a.address, a] as const)),
		});

		return Context.make(WalrusNetworkTag, networkShape).pipe(
			Context.add(WalrusNodesTag, nodesShape),
			Context.add(WalrusProxyTag, proxyShape),
			Context.add(WalrusAdminTag, adminShape),
		);
	})();

	const combinedLayer = Layer.effectContext(acquireAndProject) as Layer.Layer<
		WalrusNetworkTag | WalrusNodesTag | WalrusProxyTag | WalrusAdminTag,
		WalrusError,
		any
	>;

	// Phase D (notes/parallel-graph-resolution.md §6.4): the inner sibling
	// tags `upstreamImage` and `moveSource` are LIFTED to top-level so the
	// topo scheduler can build walrus's cargo image alongside sui's boot
	// and walrus's Move-source gitFetch alongside seal's source fetch.
	// Pre-Phase-D the cluster's `composeLayers({inner, primary})` folded
	// the inner tags into the composite's `__layers` slice, which meant
	// they only started building once the composite's level was reached
	// — sui + walrus serialised in practice.
	//
	// The lift is invisible to the composite's body: `yield* upstreamImage`
	// / `yield* moveSource` still extract their respective shapes via
	// Effect's MemoMap. The inner tags now declare themselves as their
	// own dep-graph nodes (level 0 leaves with no upstream); the composite
	// declares them in `__upstreamKeys` so the topo scheduler puts them
	// at a strictly lower level than walrus's main acquire body.
	//
	// `__layers` no longer contains the inner tags — only the primary
	// `combinedLayer`. The lifted siblings are surfaced via
	// `__extraMembers`, which `flattenStackMembers` (in supervisor.ts)
	// expands to top-level entries during compose.
	//
	// `SuiTag` is the canonical Context.Service class, not a LayeredTag,
	// so we reach for its `.key` directly. Seed account tags are
	// `LayeredTag`s; `resolveUpstreamKeys` handles either shape. Inner
	// sibling tags enter the upstream list by their string keys so the
	// composite waits for them at the topo scheduler's level boundary.
	const innerSiblings: ReadonlyArray<LayeredTag<any, any, any, any>> =
		moveSource !== undefined
			? [upstreamImage as LayeredTag<any, any, any, any>, moveSource]
			: [upstreamImage as LayeredTag<any, any, any, any>];
	const __upstreamKeys = resolveUpstreamKeys([SuiTag.key, ...seedAccountTags, ...innerSiblings]);
	return {
		__layer: combinedLayer,
		// `__layers` carries ONLY the primary now. The inner sibling
		// layers ride up as separate top-level members via
		// `__extraMembers` below. Without this slimming, the composite
		// would double-build its inner tags (once at its own level, once
		// at level 0 via the lift) — Effect's MemoMap would dedupe at
		// runtime but the topo scheduler would still account for them
		// twice in level emission.
		__layers: [combinedLayer],
		__extraMembers: innerSiblings as unknown as ReadonlyArray<StackMember>,
		key: LOCAL_CLUSTER_KEY,
		__kind: 'service' as const,
		__pluginName: 'walrus',
		__displayTitle: 'walrus.cluster',
		__upstreamKeys,
	};
};
