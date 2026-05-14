// Walrus local-cluster acquire-phase internals.
//
// Everything in this file is private to the `walrus/` directory:
// constants + shared types + the per-phase helpers
// (`buildWrapperImage`, `deployContracts`, `registerCommittee`,
// `startStorageNodes`, `resolveExchange`, `startProxy`,
// `seedWalForAccounts`, `swapSuiForWal`) and the top-level
// `acquireLocalCluster` orchestrator. Re-exported only via `walrus/local-cluster.ts`'s
// importer; not surfaced through the primitives barrel.
//
// Same observability spans as the previous monolithic revision
// (`walrus.image`, `walrus.deploy`, `walrus.register`,
// `walrus.exchange`, `walrus.nodes`, `walrus.proxy`,
// `walrus.seed-accounts`).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';
import { Effect, FileSystem, Option } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import {
	type WalrusAdminShape,
} from '../../interfaces/walrus.js';
import * as Docker from '../../internal/docker.js';
import { EngineHandle } from '../../internal/engine.js';
import { rewriteToHostGateway } from '../../internal/host-gateway.js';
import { Identity } from '../../internal/identity.js';
import { PortAllocator } from '../../internal/port-allocator.js';
import { EndpointRegistry, PackageRegistry } from '../../internal/registries.js';
import { StateStore } from '../../internal/state-store.js';
import { stringifyCause } from '../../internal/stringify-cause.js';
import { type PluginTag } from '../../tag.js';
import { WalrusError } from '../errors.js';
import type { Account } from '../shared.js';
import { Sui } from '../sui.js';

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
// Default proxy host port. Pinned to the same value the storage nodes
// register on chain as their `public_port` (`containerApiPort`, 9185 by
// default) so SDK clients keyed on `Host: walrus-node-N.localhost:9185`
// land on the proxy. Browsers resolve `*.localhost` to 127.0.0.1, so
// the proxy has to listen on 127.0.0.1:9185 for SDK blob uploads to
// reach it.
export const DEFAULT_PROXY_PORT = 9185;
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_EPOCH_DURATION = '24h';
export const DEFAULT_SHARDS = 100;
export const DEFAULT_SEED_WAL_PAYMENT_MIST = 500_000_000n;

// nginx tag used to front the storage-node committee. Held to a small
// pinned alpine variant so cold-pull latency is bounded.
const PROXY_IMAGE = 'nginx:alpine';

// Host gateway the containers can reach the host network through.
// `Docker.run` now wires `--add-host=host.docker.internal:host-gateway`
// by default, so this works uniformly on Linux + Docker Desktop.

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
const WALRUS_NODE_IP_BASE = 10;

// Derive a deterministic /24 from `<app, stack>`. Coordinated with
// `WALRUS_NODE_IP_BASE` and the per-node IP slot logic below so a
// regenerated subnet still admits the full committee.
const subnetForStack = (app: string, stack: string): { readonly subnet: string; readonly prefix: string } => {
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
const STATE_KEY_DEPLOY_PREFIX = 'walrus/deploy-output/v1';

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
	readonly hostPort: number;
	readonly containerIp: string;
	readonly rpcUrl: string;
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
	readonly preferredProxyPort: number;
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
		const ports = yield* PortAllocator;
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
		// -------------------------------------------------------------
		const networkName = `walrus-${args.name}-net`;
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
		// 2. Deploy contracts. Cache key folds in `sui.chainId` so a
		//    regenesis of the underlying chain naturally misses the
		//    cache and re-runs deploy against the fresh chain state.
		// -------------------------------------------------------------
		const deployStateKey = `${STATE_KEY_DEPLOY_PREFIX}/${sui.chainId}`;
		const cached = yield* state.get<CachedDeployState>(deployStateKey);
		const outputDir = `${process.cwd()}/.devstack/walrus/${args.name}/deploy`;

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
				rpcUrl: sui.rpcUrl,
				faucetUrl: sui.faucetUrl,
				nodeCount: args.nodeCount,
				shards: args.shards,
				epochDuration: args.epochDuration,
				containerApiPort: args.containerApiPort,
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
		// `inNetworkFaucet` was computed inside `deployContracts` above;
		// recompute it here (same shape — sui.faucetUrl or sui.rpcUrl
		// with localhost → host.docker.internal, no `/gas` suffix yet).
		// `WALRUS_FAUCET_URL` in run.sh appends the path explicitly via
		// `--url`, so we pass the full URL with `/v1/gas`.
		const nodeFaucetBase =
			sui.faucetUrl !== undefined
				? rewriteToHostGateway(sui.faucetUrl).replace(/\/+$/, '')
				: rewriteToHostGateway(sui.rpcUrl).replace(/\/+$/, '');
		const nodeFaucetUrl = `${nodeFaucetBase}/v1/gas`;
		const nodes = yield* startStorageNodes({
			name: args.name,
			image,
			nodeCount: args.nodeCount,
			containerApiPort: args.containerApiPort,
			readyTimeoutMs: args.readyTimeoutMs,
			deployDir: deploy.outputDir,
			network: networkName,
			subnetPrefix: walrusSubnetPrefix,
			portAllocator: ports,
			faucetUrl: nodeFaucetUrl,
		});

		// -------------------------------------------------------------
		// 5. Exchange object — resolve the wal_exchange package id by
		//    reading the exchange object's `.type` on chain.
		// -------------------------------------------------------------
		const exchange = yield* resolveExchange({
			rpcUrl: sui.rpcUrl,
			walrusPackageId: deploy.walrusPackageId,
			exchangeObject: deploy.exchangeObject,
		});

		// -------------------------------------------------------------
		// 6. Proxy — single nginx in front of the committee.
		// -------------------------------------------------------------
		yield* args.pushPhase('starting proxy');
		const proxyPort = yield* ports.allocate(args.preferredProxyPort).pipe(
			Effect.mapError(
				(cause) =>
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: could not allocate host port near ${args.preferredProxyPort}: ${cause.message}`,
						cause,
					}),
			),
		);
		const proxyUrl = yield* startProxy({
			name: args.name,
			nodes,
			proxyPort,
			containerApiPort: args.containerApiPort,
			network: networkName,
		});

		// -------------------------------------------------------------
		// 7. Seed accounts — swap SUI for WAL on each declared signer.
		// -------------------------------------------------------------
		if (exchange !== undefined && seedAccounts.length > 0) {
			yield* seedWalForAccounts({
				accounts: seedAccounts,
				exchange,
				paymentMist: args.seedPaymentMist,
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
// Phase 1: image (wrapper stage)
// -----------------------------------------------------------------------------

// Build the wrapper image that layers a matching sui binary + the
// vendored `deploy.sh` / `run.sh` scripts on top of the upstream
// cargo-built walrus image. We can't run this through the
// `dockerImage({build})` factory because the wrapper's `BASE_IMAGE`
// build-arg is the upstream's content-addressed tag, which only
// resolves at runtime — `dockerImage` captures `buildArgs` by closure
// at factory call time. Calling `Docker.build` directly here keeps
// the wrapper's input hash dependent on the upstream's tag so an
// upstream rebuild flips this tag too.
const buildWrapperImage = (args: {
	name: string;
	context: string;
	baseImage: string;
	suiVersion: string;
}): Effect.Effect<string, WalrusError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.fn('walrus.image')(function* () {
		// Content-addressed tag from a coarse hash of the build inputs.
		// Matches the shape `dockerImage` would produce for the upstream
		// side so the two tags share a consistent naming convention.
		const inputs = {
			context: args.context,
			dockerfile: 'wrapper.Dockerfile',
			buildArgs: { BASE_IMAGE: args.baseImage, SUI_VERSION: args.suiVersion },
		};
		const hash = createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 12);
		const tag = `devstack-${args.name}.image:${hash}`;
		const result = yield* Docker.build({
			context: args.context,
			dockerfile: 'wrapper.Dockerfile',
			tag,
			buildArgs: { BASE_IMAGE: args.baseImage, SUI_VERSION: args.suiVersion },
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'image',
						message: `walrus.image: failed to build wrapper from BASE_IMAGE='${args.baseImage}': ${cause.message}`,
						cause,
					}),
				),
			),
		);
		return result.tag;
	})();

// -----------------------------------------------------------------------------
// Phase 2: deploy
// -----------------------------------------------------------------------------

const deployContracts = (args: {
	name: string;
	image: string;
	rpcUrl: string;
	faucetUrl: string | undefined;
	nodeCount: number;
	shards: number;
	epochDuration: string;
	containerApiPort: number;
	outputDir: string;
	subnetPrefix: string;
}) =>
	Effect.fn('walrus.deploy')(function* () {
		const fs = yield* FileSystem.FileSystem;

		// Carve out a host directory for the deploy outputs. Bind-mounted
		// into the deploy one-shot (rw) and the storage node containers
		// (ro). Lives under `<cwd>/.devstack/walrus/<name>/deploy` rather
		// than v3's per-stack path — devstack-effect has no env-aware
		// path helper yet.
		const outputDir = args.outputDir;
		yield* fs.makeDirectory(outputDir, { recursive: true }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'deploy',
						message: `walrus.deploy: failed to prep output dir '${outputDir}': ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);

		// Translate the host-side sui rpc / faucet URLs into addresses
		// reachable from inside the deploy container. `Docker.run` now
		// wires `host.docker.internal:host-gateway` for us; the deploy
		// one-shot inherits the same default via `Docker.runOneShot`.
		// `rewriteToHostGateway` runs through `new URL(...).toString()`
		// which re-adds a trailing `/` on a path-less base — strip it
		// before appending the `/gas` suffix below so we don't end up
		// hitting `host.docker.internal:9123//gas` (404).
		const stripTrailingSlash = (u: string): string => (u.endsWith('/') ? u.slice(0, -1) : u);
		const inNetworkRpc = stripTrailingSlash(rewriteToHostGateway(args.rpcUrl));
		const inNetworkFaucet = stripTrailingSlash(
			args.faucetUrl !== undefined ? rewriteToHostGateway(args.faucetUrl) : inNetworkRpc,
		);

		const publicHosts = Array.from(
			{ length: args.nodeCount },
			(_, i) => `walrus-node-${i}.localhost`,
		).join(' ');
		// Pinned subnet IPs that the storage-node containers will claim
		// at startup (see `startStorageNodes`). deploy-walrus.sh requires
		// `WALRUS_LISTENING_IPS` to agree with those `--ip` pins so the
		// on-chain committee record's bind addresses match what the
		// nodes actually listen on. Kept in lockstep with the IP
		// computation in `startStorageNodes`.
		const listeningIps = Array.from(
			{ length: args.nodeCount },
			(_, i) => `${args.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`,
		).join(' ');

		// v3's deploy-walrus.sh expects these env vars exactly. The
		// public image likely lacks the script — see the deploy result
		// check below for the fallback path.
		const env: Record<string, string> = {
			WALRUS_PUBLIC_HOSTS: publicHosts,
			WALRUS_LISTENING_IPS: listeningIps,
			WALRUS_REST_API_PORT: String(args.containerApiPort),
			WALRUS_COMMITTEE_SIZE: String(args.nodeCount),
			WALRUS_SHARDS: String(args.shards),
			WALRUS_EPOCH_DURATION: args.epochDuration,
			WALRUS_NETWORK: `${inNetworkRpc};${inNetworkFaucet}/gas`,
		};

		const result = yield* Docker.runOneShot({
			name: `walrus-${args.name}-deploy`,
			image: args.image,
			env,
			mounts: [{ host: outputDir, container: '/opt/walrus/outputs' }],
			args: ['/bin/bash', '-c', '/opt/walrus/scripts/deploy-walrus.sh'],
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'deploy',
						message: `walrus.deploy: container failed: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'deploy',
					message: `walrus.deploy: deploy script exited ${result.exitCode} (image ${args.image})`,
					stderr: result.stderr,
					stdout: result.stdout,
					exitCode: result.exitCode,
				}),
			);
		}

		// v3 reads `<outputDir>/deploy` (a plain `key: value` file). We
		// reproduce its parser inline so the only host-side dependency
		// is whatever the deploy script wrote.
		const deployFile = `${outputDir}/deploy`;
		const text = yield* fs.readFileString(deployFile).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'deploy',
						message: `walrus.deploy: could not read deploy summary at ${deployFile}: ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);
		return yield* parseDeployFile(outputDir, text);
	})();

// `parseDeployFile` mirrors v3's `parseDeployFile` byte-for-byte (the
// upstream walrus-deploy tool writes `key: value` newline-separated
// pairs with `None` sentinels for absent optional fields).
const parseDeployFile = (
	outputDir: string,
	text: string,
): Effect.Effect<DeployState, WalrusError> =>
	Effect.gen(function* () {
		const get = (key: string): string | undefined => {
			const m = text.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'));
			const value = m?.[1];
			if (value === undefined || value === 'None') return undefined;
			return value;
		};
		const walrusPackageId = get('package_id');
		const systemObject = get('system_object');
		const stakingObject = get('staking_object');
		if (
			walrusPackageId === undefined ||
			systemObject === undefined ||
			stakingObject === undefined
		) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'deploy',
					message:
						`walrus.deploy: deploy file missing one of ` +
						`{package_id, system_object, staking_object}:\n` +
						text.slice(0, 400),
				}),
			);
		}
		const state: DeployState = {
			outputDir,
			walrusPackageId,
			systemObject,
			stakingObject,
			upgradeManagerObject: get('upgrade_manager_object'),
			treasuryObject: get('treasury_object'),
			exchangeObject: get('exchange_object'),
		};
		return state;
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
// Phase 4: storage nodes
// -----------------------------------------------------------------------------

const startStorageNodes = (args: {
	name: string;
	image: string;
	nodeCount: number;
	containerApiPort: number;
	readyTimeoutMs: number;
	deployDir: string;
	network: string;
	subnetPrefix: string;
	portAllocator: typeof PortAllocator.Service;
	faucetUrl: string;
}) =>
	Effect.fn('walrus.nodes')(function* () {
		const nodes: Array<NodeState> = [];
		for (let i = 0; i < args.nodeCount; i++) {
			// Per-node host port for our supervisor-side ready probe + as
			// a debug surface. Skip `containerApiPort` itself (9185) so
			// the proxy can claim it — the on-chain committee tells SDK
			// clients to reach the nodes at `walrus-node-N.localhost:9185`
			// (resolves to 127.0.0.1), and that traffic must hit the
			// proxy's Host-header vhost router, not node-0's raw port.
			// `+ 1 + i` gives node-0=9186, node-1=9187, …; the allocator
			// scans forward if a sibling stack already holds them.
			const hostPort = yield* args.portAllocator
				.allocate(args.containerApiPort + 1 + i)
				.pipe(
					Effect.mapError(
						(cause) =>
							new WalrusError({
								phase: 'nodes',
								message: `walrus.nodes: could not allocate host port for node ${i}: ${cause.message}`,
								cause,
							}),
					),
				);
			const containerIp = `${args.subnetPrefix}.${WALRUS_NODE_IP_BASE + i}`;
			const containerName = `walrus-${args.name}-node-${i}`;

			const nodeHostname = `dryrun-node-${i}`;
			yield* Docker.run({
				name: containerName,
				image: args.image,
				args: ['/bin/bash', '-c', '/opt/walrus/scripts/run-walrus.sh'],
				ports: { [hostPort]: args.containerApiPort },
				mounts: [{ host: args.deployDir, container: '/opt/walrus/outputs' }],
				// `--hostname` so the container's actual hostname matches
				// the chain-registered name (walrus-node reads its own
				// hostname when self-identifying to peers). The redundant
				// HOSTNAME env var is preserved as a belt-and-braces
				// signal for run.sh which historically read it.
				// `WALRUS_FAUCET_URL` overrides run.sh's legacy default of
				// `http://sui-localnet:9123/gas` (a docker-DNS path that
				// only worked in v3) with the host-gateway URL we use to
				// reach the host-side sui localnet from this network.
				env: { HOSTNAME: nodeHostname, WALRUS_FAUCET_URL: args.faucetUrl },
				network: args.network,
				ip: containerIp,
				hostname: nodeHostname,
				networkAlias: `walrus-node-${i}.localhost`,
				detach: true,
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: failed to start storage node ${i}: ${cause.message}`,
							cause,
						}),
					),
				),
			);

			// Wait for the node's API port to answer something — same
			// "any HTTP response means alive" semantics as before.
			// `awaitContainerReady` races the probe against the storage-
			// node container's exit, so a node that crashes (run.sh
			// faucet failure, walrus-deploy schema mismatch, …) surfaces
			// its stderr in the error instead of timing out blind.
			yield* Docker.awaitContainerReady({
				containerName,
				probe: {
					kind: 'tcp',
					host: '127.0.0.1',
					port: hostPort,
					timeoutMs: args.readyTimeoutMs,
				},
			}).pipe(
				Effect.catchTag('ReadyProbeError', (cause) =>
					Effect.fail(
						new WalrusError({
							phase: 'nodes',
							message: `walrus.nodes: storage node ${i} never became ready: ${cause.message}`,
							stderr: cause.detail,
							cause,
						}),
					),
				),
			);

			nodes.push({
				index: i,
				hostPort,
				containerIp,
				rpcUrl: `http://127.0.0.1:${hostPort}`,
			});
		}
		return nodes;
	})();

// -----------------------------------------------------------------------------
// Phase 5: exchange
// -----------------------------------------------------------------------------

const resolveExchange = (args: {
	rpcUrl: string;
	walrusPackageId: string;
	exchangeObject: string | undefined;
}): Effect.Effect<ExchangeState | undefined, WalrusError> =>
	Effect.fn('walrus.exchange')(function* () {
		if (args.exchangeObject === undefined) {
			// Deploy ran without `--with-wal-exchange`. Skip silently —
			// seed-account swaps will short-circuit on the same check.
			return undefined;
		}
		const client = new SuiJsonRpcClient({ url: args.rpcUrl, network: 'localnet' });
		const info = yield* Effect.tryPromise({
			try: () => client.core.getObject({ objectId: args.exchangeObject! }),
			catch: (cause) =>
				new WalrusError({
					phase: 'exchange',
					message: `walrus.exchange: getObject failed: ${stringifyCause(cause)}`,
					cause,
				}),
		});
		const exchangeType = info.object.type;
		const packageId = exchangeType.split('::')[0];
		if (packageId === undefined || !packageId.startsWith('0x')) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'exchange',
					message:
						`walrus.exchange: unexpected exchange object type "${exchangeType}" — ` +
						`expected "<pkg>::wal_exchange::Exchange"`,
				}),
			);
		}
		return {
			objectId: args.exchangeObject,
			packageId,
			walType: `${args.walrusPackageId}::wal::WAL`,
		};
	})();

// -----------------------------------------------------------------------------
// Phase 6: proxy
// -----------------------------------------------------------------------------

const startProxy = (args: {
	name: string;
	nodes: ReadonlyArray<NodeState>;
	proxyPort: number;
	containerApiPort: number;
	network: string;
}) =>
	Effect.fn('walrus.proxy')(function* () {
		if (args.nodes.length === 0) {
			return yield* Effect.fail(
				new WalrusError({
					phase: 'proxy',
					message: 'walrus.proxy: at least one storage node is required',
				}),
			);
		}
		const fs = yield* FileSystem.FileSystem;

		// nginx config: one server block per node, vhost-routed by Host
		// header. Now that the proxy joins the shared docker network,
		// upstreams resolve directly to each node's pinned IP — no host
		// gateway round-trip needed.
		const config = renderProxyConfig({
			nodes: args.nodes,
			proxyContainerPort: args.proxyPort,
			containerApiPort: args.containerApiPort,
		});
		const configDir = `${process.cwd()}/.devstack/walrus/${args.name}/proxy`;
		const configPath = `${configDir}/nginx.conf`;
		yield* fs.makeDirectory(configDir, { recursive: true }).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: could not prep config dir: ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);
		yield* fs.writeFileString(configPath, config).pipe(
			Effect.catch((cause: unknown) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: could not write nginx.conf: ${stringifyCause(cause)}`,
						cause,
					}),
				),
			),
		);

		const containerName = `walrus-${args.name}-proxy`;
		yield* Docker.run({
			name: containerName,
			image: PROXY_IMAGE,
			ports: { [args.proxyPort]: args.proxyPort },
			mounts: [{ host: configPath, container: '/etc/nginx/nginx.conf' }],
			network: args.network,
			detach: true,
		}).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: failed to start nginx: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		yield* Docker.awaitContainerReady({
			containerName,
			probe: {
				kind: 'tcp',
				host: '127.0.0.1',
				port: args.proxyPort,
				timeoutMs: 30_000,
			},
		}).pipe(
			Effect.catchTag('ReadyProbeError', (cause) =>
				Effect.fail(
					new WalrusError({
						phase: 'proxy',
						message: `walrus.proxy: nginx never became ready: ${cause.message}`,
						stderr: cause.detail,
						cause,
					}),
				),
			),
		);

		return `http://127.0.0.1:${args.proxyPort}`;
	})();

// nginx config renderer — single port, N vhosts keyed on Host header.
// Upstreams resolve to the per-node pinned IP on the shared docker
// network, hitting the container's API port directly (no host port
// indirection inside the network).
//
// CORS: walrus storage nodes don't set CORS headers themselves, so a
// browser at `http://localhost:5173-5180` (the dev-server slot range)
// reaching `http://walrus-node-N.localhost:9185` gets blocked at the
// preflight. The proxy injects permissive CORS headers and short-
// circuits OPTIONS with a 204 — only the localhost dev-server is on
// the wire here, and an explicit allowlist would have to enumerate
// every example's vite port (and any user-pinned port too), so we
// reflect the request `Origin` instead. Same posture the seal-key-
// server sets internally.
const renderProxyConfig = (opts: {
	nodes: ReadonlyArray<NodeState>;
	proxyContainerPort: number;
	containerApiPort: number;
}): string => {
	const sortedNodes = [...opts.nodes].sort((a, b) => a.index - b.index);
	const servers = sortedNodes
		.map((node) => {
			const upstream = `http://${node.containerIp}:${opts.containerApiPort}`;
			const serverName = `walrus-node-${node.index}.localhost`;
			return `	server {
		listen 0.0.0.0:${opts.proxyContainerPort};
		server_name ${serverName};
		location / {
			if ($request_method = OPTIONS) {
				add_header Access-Control-Allow-Origin $http_origin always;
				add_header Access-Control-Allow-Methods 'GET,POST,PUT,DELETE,PATCH,OPTIONS' always;
				add_header Access-Control-Allow-Headers $http_access_control_request_headers always;
				add_header Access-Control-Max-Age 86400 always;
				add_header Content-Length 0 always;
				return 204;
			}
			add_header Access-Control-Allow-Origin $http_origin always;
			add_header Access-Control-Expose-Headers '*' always;
			proxy_pass ${upstream};
			proxy_set_header Host $host;
			proxy_request_buffering off;
			proxy_buffering off;
			client_max_body_size 0;
		}
	}`;
		})
		.join('\n');
	return `events {}
http {
${servers}
}
`;
};

// -----------------------------------------------------------------------------
// Phase 7: seed accounts
// -----------------------------------------------------------------------------

const seedWalForAccounts = (args: {
	accounts: ReadonlyArray<Account>;
	exchange: ExchangeState;
	paymentMist: bigint;
}): Effect.Effect<void, WalrusError> =>
	Effect.fn('walrus.seed-accounts')(function* () {
		for (const account of args.accounts) {
			yield* swapSuiForWal(account, args.exchange, args.paymentMist);
		}
	})();

const swapSuiForWal = (
	account: Account,
	exchange: ExchangeState,
	paymentMist: bigint,
): Effect.Effect<void, WalrusError> =>
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

		yield* account.signAndExecute(tx).pipe(
			Effect.mapError(
				(cause) =>
					new WalrusError({
						phase: 'seed',
						message: `walrus.seedAccounts: swap failed for '${account.name}': ${cause.message}`,
						cause,
					}),
			),
		);
	}).pipe(Effect.withSpan(`walrus.seed-accounts.${account.name}`));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// `rewriteToHostGateway` moved to `internal/host-gateway.ts` so siblings
// (seal, deepbook, …) can share the same `localhost → host.docker.internal`
// rewrite. Re-imported from there at the top of this file.
