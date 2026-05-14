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
import { Effect, Option } from 'effect';
import { Transaction } from '@mysten/sui/transactions';
import { type WalrusAdminShape } from '../../interfaces/walrus.js';
import * as Docker from '../../internal/docker.js';
import { EngineHandle } from '../../internal/engine.js';
import { Identity } from '../../internal/identity.js';
import { EndpointRegistry, PackageRegistry } from '../../internal/registries.js';
import { StateStore } from '../../internal/state-store.js';
import { type PluginTag } from '../../tag.js';
import { WalrusError } from '../errors.js';
import type { Account } from '../shared.js';
import { Sui, suiNetworkName } from '../sui.js';
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

// StateStore key prefix for the cached deploy summary. Versioned so
// future schema bumps invalidate stale caches automatically. The full
// key folds in `Sui.chainId` (see use site below) so a regenesis of
// the underlying chain (`--force-regenesis`) naturally misses the
// cache and re-runs the deploy one-shot against the fresh chain
// state instead of pinning to stale package ids.
//
// The v3 prefix bump corresponds to the router migration: a v2-shaped
// cached deploy advertises non-stack-scoped `walrus-node-N.localhost`
// hostnames as each node's `network_address` on chain, but the
// post-router primitive registers stack-scoped
// `walrus-node-N.<app>.localhost` (main) / `<stack>.walrus-node-N.<app>.localhost`
// (non-main). A v2 cache would mis-route the SDK on the next boot —
// the v3 prefix invalidates those stale caches automatically.
const STATE_KEY_DEPLOY_PREFIX = 'walrus/deploy-output/v3';

// StateStore key prefix for the cached seedWal swap results. Keyed by
// `(chainId, exchange.objectId, account.address)` so:
//   - regenesis flips `chainId` ⇒ miss ⇒ fresh swap
//   - a different exchange object ⇒ miss
//   - per-account isolation so adding a new seed account doesn't
//     trample the others' cache
// The cached value records the swap tx digest for debugging; the swap
// is verified via a balance probe on cache hit (see `swapSuiForWal`).
const STATE_KEY_SEED_WAL_PREFIX = 'walrus/seed-wal/v1';

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
	readonly upstreamImage: PluginTag<any, any, any, any>;
	readonly moveSource: PluginTag<any, any, any, any> | undefined;
	readonly movePackagePath: string | undefined;
	readonly seedAccountTags: ReadonlyArray<PluginTag<any, Account, any, any>>;
	readonly pushPhase: (phase: string) => Effect.Effect<void>;
}): Effect.Effect<LocalClusterAcquired, WalrusError, any> =>
	Effect.gen(function* () {
		// -------------------------------------------------------------
		// 0. Yield Sui — pins the dependency edge + gives us rpcUrl /
		//    client for register, exchange-discovery, seed-accounts.
		// -------------------------------------------------------------
		const sui = yield* Sui;
		const state = yield* StateStore;
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
		// 2. Deploy contracts. Cache key folds in `sui.chainId` only —
		//    no per-stack proxy port any more, since the Traefik router
		//    binds 9185 once on the host and routes by `Host:` header
		//    to the per-stack backend. A regenesis still flips
		//    `chainId` and misses the cache.
		// -------------------------------------------------------------
		const deployStateKey = `${STATE_KEY_DEPLOY_PREFIX}/${sui.chainId}`;
		const cached = yield* state.get<CachedDeployState>(deployStateKey);
		// Output dir is keyed by `(identity.app, identity.stack,
		// identity.network, args.name)` so two parallel stacks of the
		// same app don't trample each other's on-disk deploy state. The
		// default `<stack='main', network='localnet'>` keeps the
		// pre-change `.devstack/walrus/${name}/deploy` path byte-
		// identical so existing walrus state is still resumable.
		const outputDirBase =
			identity.stack === 'main'
				? `${process.cwd()}/.devstack/walrus/${args.name}/deploy`
				: `${process.cwd()}/.devstack/walrus/${identity.stack}/${args.name}/deploy`;
		const outputDir =
			identity.network === 'localnet' ? outputDirBase : `${outputDirBase}-${identity.network}`;

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

		let deploy: DeployState;
		if (Option.isSome(cached)) {
			yield* Effect.annotateCurrentSpan({
				'walrus.deploy.cache': 'hit',
				'walrus.packageId': cached.value.walrusPackageId,
			});
			deploy = { outputDir, ...cached.value };
		} else {
			yield* args.pushPhase('deploying contracts');
			deploy = yield* deployContracts({
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
				walrusPackageId: deploy.walrusPackageId,
				systemObject: deploy.systemObject,
				stakingObject: deploy.stakingObject,
				...(deploy.upgradeManagerObject !== undefined
					? { upgradeManagerObject: deploy.upgradeManagerObject }
					: {}),
				...(deploy.treasuryObject !== undefined ? { treasuryObject: deploy.treasuryObject } : {}),
				...(deploy.exchangeObject !== undefined ? { exchangeObject: deploy.exchangeObject } : {}),
			};
			yield* state.put(deployStateKey, toCache);
			yield* Effect.annotateCurrentSpan({
				'walrus.deploy.cache': 'miss',
				'walrus.packageId': deploy.walrusPackageId,
				'walrus.systemObject': deploy.systemObject,
			});
		}

		// -------------------------------------------------------------
		// 3. Register storage nodes on chain — folded into the deploy
		//    one-shot today; this phase is a typed no-op span.
		// -------------------------------------------------------------
		yield* args.pushPhase('registering nodes');
		yield* registerCommittee({
			signer: seedAccounts[0],
			deploy,
			nodeCount: args.nodeCount,
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
			sui.faucet?.container ??
				sui.rpc.container ??
				sui.faucet?.host ??
				sui.rpc.host,
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
		});

		// -------------------------------------------------------------
		// 5. Exchange object — resolve the wal_exchange package id by
		//    reading the exchange object's `.type` on chain.
		// -------------------------------------------------------------
		// `resolveExchange` issues a `getObject` RPC from the host
		// supervisor — use `rpc.host` (the routed URL).
		const exchange = yield* resolveExchange({
			rpcUrl: sui.rpc.host,
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
		// 7. Seed accounts — swap SUI for WAL on each declared signer.
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
		yield* PackageRegistry.publish({
			name: `walrus.${args.name}`,
			packageId: deploy.walrusPackageId,
			mvrPlaceholder: '@local/walrus',
			captured: {
				systemObject: deploy.systemObject,
				stakingObject: deploy.stakingObject,
				...(deploy.exchangeObject !== undefined ? { exchangeObject: deploy.exchangeObject } : {}),
			},
		});

		yield* EndpointRegistry.publish({ name: 'walrus-aggregator', url: proxyUrl, kind: 'http' });
		yield* EndpointRegistry.publish({ name: 'walrus-publisher', url: proxyUrl, kind: 'http' });
		for (const node of nodes) {
			yield* EndpointRegistry.publish({
				name: `walrus-node-${node.index}`,
				url: node.rpcUrl,
				kind: 'walrus-node',
			});
		}

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
// WalrusAdmin construction
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
}): WalrusAdminShape => ({
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
// land. Kept co-located with the orchestrator because the body is one
// `annotateCurrentSpan` call and the TODO is part of the orchestrator's
// phase narrative.
const registerCommittee = (args: {
	signer: Account | undefined;
	deploy: DeployState;
	nodeCount: number;
}): Effect.Effect<void, WalrusError> =>
	Effect.fn('walrus.register')(function* () {
		// Surface the publisher's address as a span attribute when one
		// was passed — handy when debugging "why didn't this account
		// get registered" mismatches against the deploy outputs.
		if (args.signer !== undefined) {
			yield* Effect.annotateCurrentSpan({
				'walrus.publisher': args.signer.address,
				'walrus.nodeCount': args.nodeCount,
				'walrus.packageId': args.deploy.walrusPackageId,
			});
		}
		// TODO: per-node `walrus::system::register_storage_node` moveCall fan-out when the wrapper image's deploy path is split across publish + register.
	})();

// -----------------------------------------------------------------------------
// Phase 7: seed accounts
// -----------------------------------------------------------------------------

// Kept co-located with the orchestrator + `makeAdminShape` because the
// swap is reused on the ad-hoc `WalrusAdmin.seedWal` path too.
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
}): Effect.Effect<void, WalrusError, Sui | StateStore> =>
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
}): Effect.Effect<void, WalrusError, Sui | StateStore> =>
	Effect.gen(function* () {
		const sui = yield* Sui;
		const state = yield* StateStore;
		const cacheKey = `${STATE_KEY_SEED_WAL_PREFIX}/${sui.chainId}/${args.exchange.objectId}/${args.account.address}`;
		const cached = yield* state.get<CachedSeedWalSwap>(cacheKey);

		if (Option.isSome(cached)) {
			// Verify the recorded swap still shows up on chain as WAL
			// balance. A wiped volume or external balance drain
			// invalidates the cache; otherwise we trust the prior swap.
			const walType = args.exchange.walType;
			const ok = yield* probeWalBalance({
				address: args.account.address,
				walType,
			}).pipe(Effect.catch(() => Effect.succeed(0n)));
			if (ok >= SEED_WAL_BALANCE_FLOOR_FROST) {
				yield* Effect.annotateCurrentSpan({
					'walrus.seed.cache': 'hit',
					'walrus.seed.account': args.account.name,
					'walrus.seed.address': args.account.address,
					'walrus.seed.balance': ok.toString(),
				});
				return;
			}
			yield* Effect.annotateCurrentSpan({
				'walrus.seed.cache': 'stale',
				'walrus.seed.account': args.account.name,
				'walrus.seed.balance': ok.toString(),
			});
			yield* state.remove(cacheKey).pipe(Effect.catch(() => Effect.void));
		} else {
			yield* Effect.annotateCurrentSpan({
				'walrus.seed.cache': 'miss',
				'walrus.seed.account': args.account.name,
			});
		}

		const digest = yield* swapSuiForWal(args.account, args.exchange, args.paymentMist);
		const toCache: CachedSeedWalSwap = {
			digest,
			paymentMist: args.paymentMist.toString(),
			seededAt: new Date().toISOString(),
		};
		// Best-effort cache write — the swap has settled on chain
		// regardless. Falling back to re-swap on the next cycle is a
		// minor inefficiency, not a correctness bug. Catches any
		// state-store IO defect.
		yield* state.put(cacheKey, toCache).pipe(Effect.catch(() => Effect.void));
		void args.walrusPackageId;
	});

// Read a single account's WAL balance via `SuiJsonRpcClient.getBalance`.
// Returns 0 on any error so the cache-verify path falls through to a
// re-swap cleanly (better to over-seed than under-seed). The cast to
// `{ getBalance }` keeps this resilient to test mocks that satisfy
// `SuiShape` with a minimal `client` (`.core` only) — those land in
// the catch branch and we re-seed, which is the safer default.
const probeWalBalance = (args: {
	address: string;
	walType: string;
}): Effect.Effect<bigint, WalrusError, Sui> =>
	Effect.gen(function* () {
		const sui = yield* Sui;
		const client = sui.client as unknown as {
			readonly getBalance?: (a: {
				owner: string;
				coinType: string;
			}) => Promise<{ totalBalance: string }>;
		};
		if (typeof client.getBalance !== 'function') {
			return 0n;
		}
		const raw = yield* Effect.tryPromise({
			try: () =>
				client.getBalance!({
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
		try {
			return BigInt(raw.totalBalance);
		} catch {
			return 0n;
		}
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
	}).pipe(Effect.withSpan(`walrus.seed-accounts.${account.name}`));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
//
// Container-side sui URLs come from `Sui.rpc.container` /
// `Sui.faucet?.container` directly — no `localhost →
// host.docker.internal` rewrite needed, because containers now reach
// sui via the per-stack docker network's `sui-localnet` DNS alias.
