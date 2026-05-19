// Walrus local-cluster acquire-phase internals.
//
// This file owns the orchestrator (`acquireLocalCluster`), the shared
// types (`DeployState`, `NodeState`, `ExchangeState`,
// `LocalClusterAcquired`), the per-stack subnet helper, the seed-
// account swap helpers, and `makeAdminShape`. The per-phase bodies
// were split out along phase boundaries so the orchestrator stays
// small and each phase's specifics (docker build, nginx config, IP
// allocation) live next to its load-bearing comments:
//
//   - `./image.ts` — wrapper image build (phase 1)
//   - `./deploy.ts` — `walrus-deploy` one-shot + parser + exchange
//                     discovery (phases 2 + 5)
//   - `./nodes.ts` — storage-node committee + per-node port allocation
//                    (phase 4)
//   - `./proxy.ts` — nginx vhost router + config writer (phase 6)
//
// Re-exported only via `walrus/local-cluster.ts`'s importer; not
// surfaced through the primitives barrel.
//
// Same observability spans as the previous monolithic revision
// (`walrus.image`, `walrus.deploy`, `walrus.register`,
// `walrus.exchange`, `walrus.nodes`, `walrus.proxy`,
// `walrus.seed-accounts`).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { Effect } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { type WalrusAdmin } from '../walrus.js';
import * as Docker from '../../engine/docker.js';
import { EngineHandle } from '../../engine/engine.js';
import { Identity } from '../../engine/identity.js';
import { publishEndpoint, publishPackage, publishWalrusState } from '../../engine/registries.js';
import { EndpointName } from '../../runtime/endpoint-names.js';
import { servicePath } from '../../engine/service-paths.js';
import { StateStore } from '../../engine/state-store.js';
import { withCache } from '../../engine/cache.js';
import { type LayeredTag } from '../../advanced/tag.js';
import { WalrusError } from '../../engine/errors.js';
import type { Account } from '../../engine/shared.js';
import { SuiTag, suiNetworkName } from '../sui.js';
import { FaucetTag } from '../faucet/index.js';
import { walExchangeStrategy } from '../faucet/strategies/wal-exchange.js';
import { buildWrapperImage } from './image.js';
import { deployContracts, resolveExchange } from './deploy.js';
import { startStorageNodes } from './nodes.js';

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

// Pinned upstream walrus release. The same ref drives:
//   - the `gitFetch` of Move sources (downstream `publishMove` consumers)
//   - the `WALRUS_VERSION` build-arg threaded into the upstream
//     Dockerfile's `git clone --branch ${WALRUS_VERSION}` step
// Bump together — the cargo build and the Move package must agree on
// the on-chain types they emit.
export const DEFAULT_WALRUS_REPO = 'https://github.com/MystenLabs/walrus.git';
export const DEFAULT_WALRUS_REF = 'devnet-v1.48.0';
// Walrus's Move sources moved from `move/walrus` to `contracts/walrus`
// around the v1.20+ release branches. The wrapper image bakes its own
// copy of the contracts, so the gitFetch is only used by downstream
// `publishMove` consumers that want the on-disk tree.
export const DEFAULT_WALRUS_MOVE_SUBDIR = 'contracts/walrus';

// Matching sui binary baked into the wrapper image; `deploy.sh` shells
// out to it for the admin wallet bootstrap. Kept aligned with the sui
// localnet image's release so the wallet bytecode is mutually
// compatible.
export const DEFAULT_SUI_VERSION = 'devnet-v1.71.0';

// Rust toolchain to cargo-build walrus on. v3 keeps this at the
// `rust-toolchain.toml` walrus ships at the pinned tag — bump in
// lockstep with `DEFAULT_WALRUS_REF` if walrus rolls forward.
export const DEFAULT_RUST_TOOLCHAIN = '1.93';

export const DEFAULT_NODE_API_PORT = 9185;
// Well-known port the Traefik router binds for the `walrus`
// entrypoint. Storage nodes register this on chain as their
// `public_port`, and SDK clients keyed on
// `Host: walrus-node-N.<app>.localhost:9185` land on the router,
// which forwards by Host header to the right per-stack backend.
export const ROUTER_WALRUS_PORT = 9185;
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_EPOCH_DURATION = '24h';
export const DEFAULT_SHARDS = 100;
export const DEFAULT_SEED_WAL_PAYMENT_MIST = 500_000_000n;

// Host gateway is still wired automatically by `Docker.run`
// (`--add-host=host.docker.internal:host-gateway`) for the rare case a
// storage node needs to talk to a host process — but the sui RPC /
// faucet path is now docker-DNS-only (see `Sui.rpc.container`).

// Per-stack docker network /24 — storage nodes claim fixed IPs via
// `Docker.run({ip})` so the nginx proxy can address them on stable
// hostnames, and `walrus-deploy` registers each node at a deterministic
// in-network address. The /16 prefix is fixed at `10.x.0.0/24`; the
// third octet is hashed off `<app, stack>` so two parallel devstacks
// (e.g. vitest worker + playwright session) land in disjoint pools and
// don't collide with the host's default `docker0` (172.17.0.0/16) or
// other dev-tools' bridges. 100 hosts per /24 is well above any
// realistic committee size; `.1` gateway + `.2`–`.9` reserved for
// ad-hoc sidecars; storage nodes start at `.10`.
//
// `WALRUS_NODE_IP_BASE` is consumed by both `./deploy.ts`
// (`WALRUS_LISTENING_IPS` env-var fan-out so the on-chain committee
// record matches what the nodes actually bind to) and `./nodes.ts`
// (the per-node `--ip` pin) — exported here so both files agree.
export const WALRUS_NODE_IP_BASE = 10;

// Derive a deterministic /24 from `<app, stack>`. Coordinated with
// `WALRUS_NODE_IP_BASE` and the per-node IP slot logic below so a
// regenerated subnet still admits the full committee.
export const subnetForStack = (
	app: string,
	stack: string,
): { readonly subnet: string; readonly prefix: string } => {
	const h = createHash('sha256').update(`${app}/${stack}/walrus`).digest();
	// Range [16, 250]: avoid 10.0.* (often a corp VPN), 10.255.* (broadcast-y),
	// and the docker-default 172/192 blocks live in other registries.
	const octet = 16 + (h.readUInt16BE(0) % (250 - 16));
	const prefix = `10.${octet}.0`;
	return { subnet: `${prefix}.0/24`, prefix };
};

// State-store key prefixes for walrus moved to `engine/state-store-keys.ts`
// as part of Phase 5.1 of `notes/api-simplification.md`. The canonical
// builders are `StateStoreKeys.walrusDeployOutput({chainId})` and
// `StateStoreKeys.walrusSeedWal({chainId, exchangeObjectId, accountAddress})`.
// Bumping the `v<N>` segment (e.g. when the router migration retired the
// v2 walrus-deploy shape) is now a one-line edit in `state-store-keys.ts`.

// Minimum WAL balance (in FROST, WAL's smallest unit) we accept as
// proof the cached swap actually settled. Set well below
// `DEFAULT_SEED_WAL_PAYMENT_MIST` (0.5 SUI of WAL at 1:1 exchange rate)
// with slop for the gas-coin split. The exact exchange rate is
// configurable in `wal_exchange`, so this is a heuristic lower bound,
// not an invariant — undershoot triggers a re-swap which is harmless.
const SEED_WAL_BALANCE_FLOOR_FROST = 400_000_000n;

interface CachedSeedWalSwap {
	readonly digest: string;
	readonly paymentMist: string;
	readonly seededAt: string;
}

// -----------------------------------------------------------------------------
// Phase shapes — internal
// -----------------------------------------------------------------------------

export interface DeployState {
	readonly outputDir: string;
	readonly walrusPackageId: string;
	readonly systemObject: string;
	readonly stakingObject: string;
	readonly upgradeManagerObject?: string;
	readonly treasuryObject?: string;
	readonly exchangeObject?: string;
}

// Subset of `DeployState` we persist into `StateStore`. The `outputDir`
// is derived from `name` so we don't bother caching it; everything else
// is a chain-state echo that's expensive to regenerate.
interface CachedDeployState {
	readonly walrusPackageId: string;
	readonly systemObject: string;
	readonly stakingObject: string;
	readonly upgradeManagerObject?: string;
	readonly treasuryObject?: string;
	readonly exchangeObject?: string;
}

export interface ExchangeState {
	readonly objectId: string;
	readonly packageId: string;
	readonly walType: string;
}

export interface NodeState {
	readonly index: number;
	readonly containerIp: string;
	readonly rpcUrl: string;
	/**
	 * Stack-scoped router hostname this node registers on chain
	 * (`walrus-node-N.<app>.localhost` for main, `<stack>.walrus-node-N.<app>.localhost`
	 * for non-main). Folded into `rpcUrl` already; surfaced here too
	 * so the orchestrator can derive the router-fronted aggregator
	 * URL without re-parsing the URL string.
	 */
	readonly publicHostname: string;
}

// Output of the local-cluster acquire body. The four narrow interface
// services are projected from this single shape so the body runs once
// even though four `Context.Service` keys end up populated.
export interface LocalClusterAcquired {
	readonly deploy: DeployState;
	readonly nodes: ReadonlyArray<NodeState>;
	readonly proxyUrl: string;
	readonly exchange: ExchangeState | undefined;
	readonly seedAccounts: ReadonlyArray<Account>;
	readonly seedPaymentMist: bigint;
}

// Engine-visible key for the local cluster member. The TUI/engine sees a
// single tag name even though the acquire fans out into four interface
// layers underneath — that matches the user's mental model ("one walrus
// thing"). Exposed via the returned `StackMember.key`.
export const LOCAL_CLUSTER_KEY = 'walrusLocalCluster';

// -----------------------------------------------------------------------------
// Local cluster acquire — full boot
// -----------------------------------------------------------------------------

// Extracted from the previous `walrus(opts)` body. The shape is unchanged;
// only the projection step at the end is new. Returns the typed acquire
// state so the caller can split it into the four interface keys.
export const acquireLocalCluster = (args: {
	readonly name: string;
	readonly nodeCount: number;
	readonly containerApiPort: number;
	readonly shards: number;
	readonly epochDuration: string;
	readonly readyTimeoutMs: number;
	readonly seedPaymentMist: bigint;
	readonly walrusVersion: string;
	readonly suiVersion: string;
	readonly dockerContext: string;
	readonly upstreamImage: LayeredTag<any, any, any, any>;
	readonly moveSource: LayeredTag<any, any, any, any> | undefined;
	readonly movePackagePath: string | undefined;
	readonly seedAccountTags: ReadonlyArray<LayeredTag<any, Account, any, any>>;
	readonly pushPhase: (phase: string) => Effect.Effect<void>;
}): Effect.Effect<LocalClusterAcquired, WalrusError, any> =>
	Effect.gen(function* () {
		// -------------------------------------------------------------
		// 0. Yield Sui — pins the dependency edge + gives us rpcUrl /
		//    client for register, exchange-discovery, seed-accounts.
		// -------------------------------------------------------------
		const sui = yield* SuiTag;
		const identity = yield* Identity;
		const { subnet: walrusSubnet, prefix: walrusSubnetPrefix } = subnetForStack(
			identity.app,
			identity.stack,
		);

		// Eagerly resolve each declared seed account so a missing layer
		// surfaces here rather than at the swap step.
		const seedAccounts: Array<Account> = [];
		for (const tag of args.seedAccountTags) {
			seedAccounts.push(yield* tag);
		}

		// Resolve the Move package path: caller-provided wins, else we
		// fetch upstream. The fetched value isn't consumed by the
		// deploy one-shot today (the wrapper image embeds its own
		// copy) — we surface it via a span attribute and keep the
		// dependency edge so the move tree is present on disk for any
		// downstream `publishMove` consumer.
		let movePackagePath: string;
		if (args.movePackagePath !== undefined) {
			movePackagePath = args.movePackagePath;
		} else {
			const fetched = yield* args.moveSource!;
			movePackagePath = fetched.path;
		}
		yield* Effect.annotateCurrentSpan({ 'walrus.movePackagePath': movePackagePath });

		// -------------------------------------------------------------
		// 1. Image — two-stage build mirroring v3:
		//      a) upstream (cargo build of walrus binaries + contracts)
		//      b) wrapper (sui binary + deploy.sh + run.sh on top)
		// -------------------------------------------------------------
		yield* args.pushPhase('building image');
		const upstream = yield* args.upstreamImage;
		const image = yield* buildWrapperImage({
			name: args.name,
			context: args.dockerContext,
			baseImage: upstream.tag,
			suiVersion: args.suiVersion,
		});
		yield* Effect.annotateCurrentSpan({
			'walrus.image.upstream': upstream.tag,
			'walrus.image': image,
		});

		// -------------------------------------------------------------
		// 1b. Network — dedicated docker network for this stack with
		//     a pinned /24 so storage nodes can claim deterministic
		//     IPs. v3 does the same trick for intra-network DNS.
		//
		//     Network name is keyed by `(identity.app, identity.stack,
		//     identity.network, args.name)` — without the stack
		//     dimension, two parallel stacks of the same app collide on
		//     the docker network and `network create` adopts the
		//     sibling's network (with its sibling's subnet), failing
		//     downstream with `invalid config for network walrus-…-net:
		//     no configured subnet contains IP address 10.X.0.10`. The
		//     default `<stack='main', network='localnet'>` keeps the
		//     pre-change `walrus-${name}-net` shape byte-identical so
		//     warm-restart resume still adopts existing networks.
		// -------------------------------------------------------------
		const walrusBase =
			identity.stack === 'main'
				? `walrus-${args.name}-net`
				: `walrus-${identity.app}-${identity.stack}-${args.name}-net`;
		const networkName =
			identity.network === 'localnet' ? walrusBase : `${walrusBase}-${identity.network}`;
		yield* Docker.networkCreate(networkName, { subnet: walrusSubnet }).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'network',
						message: `walrus.network: failed to create '${networkName}': ${cause.message}`,
						cause,
					}),
				),
			),
		);
		yield* Effect.annotateCurrentSpan({
			'walrus.network': networkName,
			'walrus.network.subnet': walrusSubnet,
		});

		// -------------------------------------------------------------
		// 2. Deploy contracts via `withCache`. Cache key folds in
		//    `sui.chainId` so a regenesis misses cleanly. Phase C §4.2
		//    adds a `verify` probe over both the system object AND the
		//    staking object — either missing on chain invalidates the
		//    cache and we re-deploy.
		//
		//    Output dir lives at `runtime/walrus/<name>/deploy/` so the
		//    snapshot tar captures it alongside the state-store entry.
		//    The pair must round-trip together — see §5.2 of
		//    `notes/parallel-graph-resolution.md`.
		// -------------------------------------------------------------
		const outputDir = yield* servicePath('walrus', args.name, 'deploy');

		// Per-stack sui docker network — only meaningful when the sui
		// primitive runs a container (i.e. `suiLocalnet` without an
		// externally-managed RPC). Detect that case by checking
		// whether the sui endpoint exposes a `container` URL; if it
		// does, the network exists (one of `containerNetworks`) and
		// we join it so docker DNS resolves `sui-localnet`. Falls back
		// to `suiNetworkName(identity)` for defensive sanity (the
		// current sui primitive always populates `containerNetworks`
		// alongside `container`).
		const suiNet =
			sui.rpc.container !== undefined
				? (sui.rpc.containerNetworks?.[0] ?? suiNetworkName(identity))
				: undefined;

		const cachedDeploy = yield* withCache({
			namespace: 'walrus/deploy-output/v3',
			chainId: sui.chainId,
			inputs: Effect.succeed({ name: args.name }),
			// §4.2 verify probe. Two failure modes invalidate:
			//   1. The recorded systemObject is missing on chain
			//      (regenesis without state-store wipe, e.g. a docker
			//      volume reset around a stale `.devstack/`).
			//   2. The recorded stakingObject is missing on chain
			//      (same cause). Both probes must pass; either failure
			//      invalidates the cache.
			//   3. The local `deploy` outputs file is missing
			//      (manual `rm -rf` of runtime/, pre-Phase-3 snapshot
			//      restore). Without the outputs, the storage-node
			//      mount in step 4 would point at an empty dir. Per
			//      §5.2 of the plan: re-deploying on top of a chain
			//      that already has registered nodes mints NEW keys
			//      and breaks the committee, but a clean re-deploy
			//      on a chain whose systemObject ALSO went away IS
			//      safe (case `else` in deployContracts below cleans
			//      up the prior storage-node containers).
			verify: (cached: CachedDeployState) =>
				Effect.gen(function* () {
					const deployFile = `${outputDir}/deploy`;
					const deployFileExists = yield* Effect.tryPromise({
						try: () => nodeFs.access(deployFile).then(() => true),
						catch: () => false,
					}).pipe(Effect.orElseSucceed(() => false));
					if (deployFileExists !== true) {
						yield* Effect.logWarning(
							`walrus(${args.name}): state-store gate present but ${deployFile} missing — ` +
								`invalidating cache and re-deploying. Likely a partial snapshot restore ` +
								`or manual delete of runtime/. The next deploy mints fresh storage-node ` +
								`keys; ensure the previous on-chain committee object is also gone.`,
						);
						return undefined;
					}
					const systemOk = yield* probeWalrusObject(sui.client, cached.systemObject);
					if (!systemOk) {
						yield* Effect.logWarning(
							`walrus(${args.name}): cached systemObject ${cached.systemObject} not found ` +
								`on chain — invalidating deploy cache and re-deploying.`,
						);
						return undefined;
					}
					const stakingOk = yield* probeWalrusObject(sui.client, cached.stakingObject);
					if (!stakingOk) {
						yield* Effect.logWarning(
							`walrus(${args.name}): cached stakingObject ${cached.stakingObject} not found ` +
								`on chain — invalidating deploy cache and re-deploying.`,
						);
						return undefined;
					}
					return cached;
				}),
			produce: Effect.gen(function* () {
				// Cache miss means either: (a) first run for this stack,
				// or (b) `sui.chainId` changed, or (c) verify probe
				// invalidated the entry. Case (a) has no pre-existing
				// walrus-node containers to worry about; (b) + (c) are
				// the ones that break if we let `Docker.run`'s adopt-
				// if-image-matches path keep the existing storage-node
				// containers — their writable layer holds RocksDB
				// synced against the OLD chain's checkpoint sequence,
				// and walrus's own integrity check trips on first
				// start ("Current store has a checkpoint that is
				// greater than latest network checkpoint!").
				//
				// We can't recover that RocksDB; we have to drop it.
				// `docker rm -f` against the predicted container names
				// blows the writable layer away so the post-deploy
				// `Docker.run` lands on the fresh-create branch.
				//
				// Best-effort: case (a) has no containers, so each rm
				// is a no-op the helper silently ignores.
				for (let i = 0; i < args.nodeCount; i++) {
					const fullName = Docker.composeContainerName(
						identity.app,
						identity.stack,
						identity.network,
						`walrus-${args.name}-node-${i}`,
					);
					yield* Docker.removeContainerByName(fullName);
				}
				yield* args.pushPhase('deploying contracts');
				const fresh = yield* deployContracts({
					name: args.name,
					image,
					rpc: sui.rpc,
					faucet: sui.faucet,
					suiNetwork: suiNet,
					nodeCount: args.nodeCount,
					shards: args.shards,
					epochDuration: args.epochDuration,
					containerApiPort: args.containerApiPort,
					routerEntrypointPort: ROUTER_WALRUS_PORT,
					identity,
					outputDir,
					subnetPrefix: walrusSubnetPrefix,
				});
				const toCache: CachedDeployState = {
					walrusPackageId: fresh.walrusPackageId,
					systemObject: fresh.systemObject,
					stakingObject: fresh.stakingObject,
					...(fresh.upgradeManagerObject !== undefined
						? { upgradeManagerObject: fresh.upgradeManagerObject }
						: {}),
					...(fresh.treasuryObject !== undefined ? { treasuryObject: fresh.treasuryObject } : {}),
					...(fresh.exchangeObject !== undefined ? { exchangeObject: fresh.exchangeObject } : {}),
				};
				return toCache;
			}),
		});
		const deploy: DeployState = { outputDir, ...cachedDeploy };
		yield* Effect.annotateCurrentSpan({
			'walrus.packageId': deploy.walrusPackageId,
			'walrus.systemObject': deploy.systemObject,
		});

		// -------------------------------------------------------------
		// 3. Register storage nodes on chain — folded into the deploy
		//    one-shot today; this phase is a typed no-op span.
		// -------------------------------------------------------------
		yield* args.pushPhase('registering nodes');
		yield* registerCommittee({
			signer: seedAccounts[0],
			deploy,
			nodeCount: args.nodeCount,
			chainId: sui.chainId,
		});

		// -------------------------------------------------------------
		// 4. Storage nodes — N detached containers, each on a pinned
		//    in-network IP and a `PortAllocator`-issued host port.
		// -------------------------------------------------------------
		yield* args.pushPhase('starting nodes');
		// Storage-node `WALRUS_FAUCET_URL` — prefer the docker-DNS
		// faucet alias (`http://sui-localnet:9123/v1/gas`) when
		// `suiLocalnet` populated `faucet.container`; nodes join the
		// sui per-stack network alongside their own walrus-net so
		// docker DNS resolves. Fallback to the routed faucet URL for
		// externally-managed RPCs (caller is on the hook for
		// reachability in that case).
		const stripTrailingSlash = (u: string): string => u.replace(/\/+$/, '');
		const nodeFaucetBase = stripTrailingSlash(
			sui.faucet?.container ?? sui.rpc.container ?? sui.faucet?.host ?? sui.rpc.host,
		);
		const nodeFaucetUrl = `${nodeFaucetBase}/v1/gas`;
		const nodes = yield* startStorageNodes({
			name: args.name,
			image,
			nodeCount: args.nodeCount,
			containerApiPort: args.containerApiPort,
			routerEntrypointPort: ROUTER_WALRUS_PORT,
			readyTimeoutMs: args.readyTimeoutMs,
			deployDir: deploy.outputDir,
			network: networkName,
			suiNetwork: suiNet,
			subnetPrefix: walrusSubnetPrefix,
			identity,
			faucetUrl: nodeFaucetUrl,
			// Route all 4 node stop-finalizers' markStopping/markStopped to
			// the aggregate walrus-cluster row in the TUI. See the matching
			// comment on `startStorageNodes`'s `engineTagKey` param.
			engineTagKey: LOCAL_CLUSTER_KEY,
		});

		// -------------------------------------------------------------
		// 5. Exchange object — resolve the wal_exchange package id by
		//    reading the exchange object's `.type` on chain.
		// -------------------------------------------------------------
		// Phase -1 (gRPC migration): reuse the supervisor's `Sui.client`
		// rather than instantiating a fresh JSON-RPC client. The two are
		// equivalent on the wire (same RPC port) but the seam violation
		// kept independent client state — content addressing, MVR
		// overrides, the protobuf transport — that diverged from the
		// rest of devstack the moment any of those grew configuration.
		const exchange = yield* resolveExchange({
			client: sui.client,
			walrusPackageId: deploy.walrusPackageId,
			exchangeObject: deploy.exchangeObject,
		});

		// -------------------------------------------------------------
		// 6. Aggregator/publisher URL — the Traefik router replaces the
		//    per-stack nginx proxy from earlier revisions. Each storage
		//    node carries its own traefik label set (see `nodes.ts`),
		//    so vhost-routing happens at the global router instead of
		//    a sidecar nginx. We pick node-0's router-fronted URL as
		//    the representative aggregator/publisher endpoint; the SDK
		//    can fan out across all `nodes[].rpcUrl` for read paths,
		//    and any node accepts publisher writes. No second host
		//    port allocation.
		// -------------------------------------------------------------
		if (nodes.length === 0) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'proxy',
					message: 'walrus: at least one storage node is required',
				}),
			);
		}
		const proxyUrl = nodes[0]!.rpcUrl;

		// -------------------------------------------------------------
		// 7a. Register WAL auto-strategy on Faucet so any account can
		//     ask for WAL via `Account({ funding: { WAL } })` without
		//     being on `seedAccounts`. Uses `seedAccounts[0]` as the
		//     admin signer (the same account that pays for the deploy
		//     phase). Skipped when no seed accounts are declared — in
		//     that case the user must register their own strategy
		//     explicitly via `Faucet({ strategies: [...] })`.
		// -------------------------------------------------------------
		if (exchange !== undefined && seedAccounts.length > 0) {
			const faucetOpt = yield* Effect.serviceOption(FaucetTag);
			if (faucetOpt._tag === 'Some') {
				yield* faucetOpt.value.register(
					walExchangeStrategy({
						exchange: { objectId: exchange.objectId, packageId: exchange.packageId },
						signer: seedAccounts[0]!,
						defaultPaymentMist: args.seedPaymentMist,
					}),
				);
			}
		}

		// -------------------------------------------------------------
		// 7b. Seed accounts — eagerly swap SUI for WAL on each declared
		//     signer (so they're funded before downstream Refs that
		//     depend on the cluster start using them). Equivalent to
		//     calling `Faucet.requestCoin('WAL', addr, paymentMist)` for
		//     each, but kept inline to preserve the state-store
		//     idempotency path that skips already-funded accounts.
		// -------------------------------------------------------------
		if (exchange !== undefined && seedAccounts.length > 0) {
			yield* seedWalForAccounts({
				accounts: seedAccounts,
				exchange,
				paymentMist: args.seedPaymentMist,
				walrusPackageId: deploy.walrusPackageId,
			});
		}

		// -------------------------------------------------------------
		// 8. Registries — record the walrus package + endpoints so
		//    the manifest export picks them up.
		// -------------------------------------------------------------
		yield* publishPackage({
			name: `walrus.${args.name}`,
			packageId: deploy.walrusPackageId,
			mvrPlaceholder: '@local/walrus',
			captured: {
				systemObject: deploy.systemObject,
				stakingObject: deploy.stakingObject,
				...(deploy.exchangeObject !== undefined ? { exchangeObject: deploy.exchangeObject } : {}),
			},
		});

		yield* publishEndpoint({
			name: EndpointName.WALRUS_AGGREGATOR,
			url: proxyUrl,
			kind: 'http',
		});
		yield* publishEndpoint({
			name: EndpointName.WALRUS_PUBLISHER,
			url: proxyUrl,
			kind: 'http',
		});
		for (const node of nodes) {
			yield* publishEndpoint({
				name: `walrus-node-${node.index}`,
				url: node.rpcUrl,
				kind: 'walrus-node',
			});
		}
		yield* publishWalrusState({ name: args.name, systemObjectId: deploy.systemObject });

		return {
			deploy,
			nodes,
			proxyUrl,
			exchange,
			seedAccounts,
			seedPaymentMist: args.seedPaymentMist,
		} satisfies LocalClusterAcquired;
	});

// Re-export engine handle so local-cluster.ts can pull it from internal
// without doubling the import surface.
export { EngineHandle };

// -----------------------------------------------------------------------------
// WalrusAdminTag construction
// -----------------------------------------------------------------------------

// Build the admin shape from the local-cluster acquire state. `waitForCommittee`
// is a no-op today because the storage nodes are already probed for readiness
// during phase 4; the contract preserves the entry point so future revisions
// can tighten it to a quorum-status check. `seedWal` reuses the swap helper
// from phase 7 — the body's eager seeding covered the launch-time accounts;
// this surfaces the same capability for ad-hoc post-boot top-ups.
export const makeAdminShape = (args: {
	readonly nodes: ReadonlyArray<NodeState>;
	readonly exchange: ExchangeState | undefined;
	readonly defaultSeedPaymentMist: bigint;
	readonly seedAccountsByAddress: ReadonlyMap<string, Account>;
}): WalrusAdmin => ({
	waitForCommittee: Effect.void,
	seedWal: (req) =>
		Effect.gen(function* () {
			if (args.exchange === undefined) {
				return yield* Effect.fail(
					new WalrusError({
						phase: 'seed',
						message:
							'walrusAdmin.seedWal: no exchange object available (deploy ran without ' +
							'`--with-wal-exchange`)',
					}),
				);
			}
			const account = args.seedAccountsByAddress.get(req.address);
			if (account === undefined) {
				return yield* Effect.fail(
					new WalrusError({
						phase: 'seed',
						message:
							`walrusAdmin.seedWal: address '${req.address}' is not registered as a ` +
							'seed account (pass it to walrusLocalCluster({ seedAccounts: [...] }))',
					}),
				);
			}
			yield* swapSuiForWal(account, args.exchange, req.amount);
		}),
});

// -----------------------------------------------------------------------------
// Phase 3: register
// -----------------------------------------------------------------------------

// v3's `walrus-deploy deploy-system-contract` (invoked inside the
// deploy script) handles both publishing AND on-chain registration in
// one binary call. So the explicit "register" phase here is a typed
// no-op span — present so future infrastructure (per-node
// re-registration after a deploy bump, e.g.) has an obvious place to
// land.
//
// Phase C §5.4: wrapped in `withCache` so the future per-node
// re-registration fill-in is a body edit, not a structural change.
// The current `produce` body annotates the span + returns `null`; the
// verify probe matches the deploy-output verify — re-running the
// register Move call after a regenesis is harmless but should be
// re-triggered (today the deploy one-shot's own re-run handles it).
const registerCommittee = (args: {
	signer: Account | undefined;
	deploy: DeployState;
	nodeCount: number;
	chainId: string;
}): Effect.Effect<void, WalrusError, StateStore> =>
	Effect.fn('walrus.register')(function* () {
		yield* withCache({
			namespace: 'walrus/register-committee/v1',
			chainId: args.chainId,
			inputs: Effect.succeed({
				packageId: args.deploy.walrusPackageId,
				systemObject: args.deploy.systemObject,
				nodeCount: args.nodeCount,
			}),
			// No on-chain object to probe yet — registerCommittee is a
			// typed no-op so verify is `Effect.succeed(cached)`. When the
			// future per-node re-registration lands, swap this for a
			// `getObject(node.registrationId)` probe that matches the
			// deploy-output discipline above.
			verify: (cached: null) => Effect.succeed(cached),
			produce: Effect.gen(function* () {
				// Surface the publisher's address as a span attribute
				// when one was passed — handy when debugging "why didn't
				// this account get registered" mismatches against the
				// deploy outputs.
				if (args.signer !== undefined) {
					yield* Effect.annotateCurrentSpan({
						'walrus.publisher': args.signer.address,
						'walrus.nodeCount': args.nodeCount,
						'walrus.packageId': args.deploy.walrusPackageId,
					});
				}
				return null;
			}),
		});
	})();

// -----------------------------------------------------------------------------
// Phase 7: seed accounts
// -----------------------------------------------------------------------------

// Kept co-located with the orchestrator + `makeAdminShape` because the
// swap is reused on the ad-hoc `WalrusAdminTag.seedWal` path too.
//
// Resume idempotency: every supervisor cycle previously re-ran the swap
// → each seed account accumulated +0.5 WAL per restart. We cache the
// swap result keyed by `(chainId, exchange.objectId, account.address)`
// and skip on a cache hit whose recorded balance still resolves above
// `SEED_WAL_BALANCE_FLOOR_FROST`. Cache writes are best-effort — a
// state-store write failure must not fail the primitive (the swap has
// already settled on chain).
const seedWalForAccounts = (args: {
	accounts: ReadonlyArray<Account>;
	exchange: ExchangeState;
	paymentMist: bigint;
	walrusPackageId: string;
}): Effect.Effect<void, WalrusError, SuiTag | StateStore> =>
	Effect.fn('walrus.seed-accounts')(function* () {
		for (const account of args.accounts) {
			yield* swapSuiForWalCached({
				account,
				exchange: args.exchange,
				paymentMist: args.paymentMist,
				walrusPackageId: args.walrusPackageId,
			});
		}
	})();

const swapSuiForWalCached = (args: {
	account: Account;
	exchange: ExchangeState;
	paymentMist: bigint;
	walrusPackageId: string;
}): Effect.Effect<void, WalrusError, SuiTag | StateStore> =>
	Effect.gen(function* () {
		const sui = yield* SuiTag;
		yield* Effect.annotateCurrentSpan({
			'walrus.seed.account': args.account.name,
			'walrus.seed.address': args.account.address,
		});
		// `withCache` discipline — Phase C §4.2. Verify probes the
		// account's on-chain WAL balance against the floor; either a
		// wiped volume or an external balance drain invalidates the
		// cached swap and the next produce re-swaps.
		yield* withCache({
			namespace: 'walrus/seed-wal/v1',
			chainId: sui.chainId,
			inputs: Effect.succeed({
				exchangeObjectId: args.exchange.objectId,
				accountAddress: args.account.address,
			}),
			verify: (cached: CachedSeedWalSwap) =>
				Effect.gen(function* () {
					const balance = yield* probeWalBalance({
						address: args.account.address,
						walType: args.exchange.walType,
					}).pipe(Effect.orElseSucceed(() => 0n));
					yield* Effect.annotateCurrentSpan({
						'walrus.seed.balance': balance.toString(),
					});
					return balance >= SEED_WAL_BALANCE_FLOOR_FROST ? cached : undefined;
				}),
			produce: Effect.gen(function* () {
				const digest = yield* swapSuiForWal(args.account, args.exchange, args.paymentMist);
				return {
					digest,
					paymentMist: args.paymentMist.toString(),
					seededAt: new Date().toISOString(),
				} satisfies CachedSeedWalSwap;
			}),
		});
		void args.walrusPackageId;
	});

// Read a single account's WAL balance via `client.core.listCoins` and
// sum across the returned page(s). Returns 0 on any error so the
// cache-verify path falls through to a re-swap cleanly (better to
// over-seed than under-seed). Phase -1 (gRPC migration): the sui-fork
// upstream `todo!()`s `getBalance` (mitigated by Phase 1's adapter
// guard), and the gRPC `getBalance` shape changed materially; summing
// `listCoins` is the lowest-common-denominator path that works on
// both localnet and fork modes. Single-page (default limit) is
// sufficient: any seed-funded address has fewer than ~50 WAL coin
// objects in practice.
const probeWalBalance = (args: {
	address: string;
	walType: string;
}): Effect.Effect<bigint, WalrusError, SuiTag> =>
	Effect.gen(function* () {
		const sui = yield* SuiTag;
		// Defensive: test mocks may satisfy `Sui` with a minimal `client`
		// (`.core` only) or no `listCoins` at all. Treat the absence the
		// same way the old `getBalance` cast did — re-seed (returning
		// 0 here) is the safer default.
		const core = (sui.client as unknown as { readonly core?: unknown }).core;
		const listCoins = (core as { readonly listCoins?: unknown } | undefined)?.listCoins;
		if (typeof listCoins !== 'function') {
			return 0n;
		}
		const response = yield* Effect.tryPromise({
			try: () =>
				sui.client.core.listCoins({
					owner: args.address,
					coinType: args.walType,
				}),
			catch: (cause) =>
				new WalrusError({
					phase: 'seed',
					message: `walrus.seed: balance probe failed for ${args.address}`,
					cause,
				}),
		});
		let sum = 0n;
		for (const coin of response.objects) {
			try {
				sum += BigInt(coin.balance);
			} catch {
				// Skip an unparseable balance string rather than fail the
				// whole probe — over-seeding on a glitched coin row is
				// the safer fallback.
			}
		}
		return sum;
	});

const swapSuiForWal = (
	account: Account,
	exchange: ExchangeState,
	paymentMist: bigint,
): Effect.Effect<string, WalrusError> =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'walrus.seed.account': account.name,
			'walrus.seed.address': account.address,
		});

		const tx = new Transaction();
		// `useGasCoin: true` lets the SDK split the payment from the gas
		// coin — same trick the v3 helper uses to dodge "all my faucet
		// coins got reserved for gas" failures on small balances.
		const paymentCoin = tx.coin({
			balance: paymentMist,
			type: '0x2::sui::SUI',
			useGasCoin: true,
		});
		const walCoin = tx.moveCall({
			target: `${exchange.packageId}::wal_exchange::exchange_all_for_wal`,
			arguments: [tx.object(exchange.objectId), paymentCoin],
		});
		tx.transferObjects([walCoin], tx.pure.address(account.address));

		const result = yield* account.signAndExecute(tx).pipe(
			Effect.mapError(
				(cause) =>
					new WalrusError({
						phase: 'seed',
						message: `walrus.seedAccounts: swap failed for '${account.name}': ${cause.message}`,
						cause,
					}),
			),
		);
		const digest =
			typeof (result as { digest?: unknown }).digest === 'string'
				? (result as { digest: string }).digest
				: '';
		return digest;
	}).pipe(Effect.withSpan(`WalrusSeedAccounts(${account.name})`));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
//
// Container-side sui URLs come from `Sui.rpc.container` /
// `Sui.faucet?.container` directly — no `localhost →
// host.docker.internal` rewrite needed, because containers now reach
// sui via the per-stack docker network's `sui-localnet` DNS alias.

/** Probe whether `objectId` resolves on chain. Returns `true` on
 *  successful `getObject`; `false` on any failure (object missing, RPC
 *  transient, network down). Used by the walrus deploy + register
 *  withCache verify probes (§4.2 of `notes/parallel-graph-resolution.md`)
 *  so a stale cache entry — chain regenesis, snapshot mismatch — gets
 *  invalidated cleanly instead of feeding downstream consumers an
 *  unresolvable system/staking id.
 *
 *  Conservatively falls back to `false` on any failure: over-deriving
 *  on the next produce cycle is cheaper than booting against a broken
 *  cache entry. */
const probeWalrusObject = (
	// `Sui['client']` typed loosely (the SDK class isn't re-exported from
	// this module's import surface). The probe only touches
	// `client.core.getObject({objectId})` which is part of the stable
	// gRPC surface.
	client: {
		readonly core: { readonly getObject: (args: { objectId: string }) => Promise<unknown> };
	},
	objectId: string,
): Effect.Effect<boolean> =>
	Effect.tryPromise({
		try: () => client.core.getObject({ objectId }),
		catch: (cause) => cause,
	}).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);
