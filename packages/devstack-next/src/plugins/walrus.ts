import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Keypair } from '@mysten/sui/cryptography';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import type { Dep, Producer, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { runTransaction } from '../helpers/run-transaction.js';
import { dockerContainer } from '../runners/docker-container.js';
import { dockerImage } from '../runners/docker-image.js';
import { dockerNetwork } from '../runners/docker-network.js';
import { dockerOneShot } from '../runners/docker-one-shot.js';
import type { Endpoint, Package } from '../shapes/index.js';
import { sui, SUI_DEFAULT_VERSION, SUI_LOCALNET_NETWORK_ALIAS } from './sui.js';

const DEFAULT_NODE_API_PORT = 9185;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_EPOCH_DURATION = '24h';
const DEFAULT_SHARDS = 100;

/** Pinned walrus release tag. Doubles as a git ref so BuildKit can
 * fetch matching source for the cargo-build stage of `walrus.image
 * .upstream`. Bump in lockstep with `WALRUS_RUST_TOOLCHAIN` if the
 * walrus tree's pinned `rust-toolchain.toml` moves. */
export const WALRUS_DEFAULT_VERSION = 'devnet-v1.48.0';
const WALRUS_REPO = 'https://github.com/MystenLabs/walrus.git';
/** Rust toolchain version for the walrus-build stage. Tracks walrus's
 * pinned `rust-toolchain.toml` at WALRUS_DEFAULT_VERSION (typed-store
 * uses APIs stabilized in 1.93). */
const WALRUS_RUST_TOOLCHAIN = '1.93';

// Vendored Dockerfiles + scripts ship under `src/plugins/walrus/docker/`.
// `tsdown.config.ts` mirrors them to `dist/plugins/walrus/docker/` so
// `import.meta.url` resolves the same path in source and built outputs.
const DOCKER_CONTEXT = fileURLToPath(new URL('./walrus/docker/', import.meta.url));

export interface WalrusOptions {
	/** Number of storage nodes to spin up. Default 1. PLAN.md L6 sketches
	 * a 3-node committee as the canonical example. */
	nodeCount?: number;
	/** Pinned walrus release tag (e.g. `'devnet-v1.48.0'`). Becomes a
	 * `--build-arg` to the upstream Dockerfile and the git ref the
	 * BuildKit `walrus-src` named context fetches from. */
	version?: string;
	/** Sui release tag baked into the wrapper image (the run.sh script
	 * uses the in-image sui binary for keystore + faucet calls).
	 * Defaults to the same `SUI_DEFAULT_VERSION` the sui plugin uses. */
	suiVersion?: string;
	/** Pre-built storage-node image. When set, `walrus.image*` builds
	 * are skipped and the literal tag is used directly. Useful for
	 * CI-published images or pinning to an upstream tag. */
	image?: string;
	/** API container port on each node. Host port is allocated. */
	containerApiPort?: number;
	/** Per-node ready-probe timeout. Default 60s. */
	readyTimeoutMs?: number;
	/** Number of shards distributed across the committee. Default 100
	 * (matches walrus testbed's hardcoded value). Must be >= nodeCount. */
	shards?: number;
	/** Walrus epoch duration. Default `'24h'` so blobs uploaded with
	 * `epochs: 1` survive a normal supervisor restart cycle. */
	epochDuration?: string;
	/** Override per-node RPC URLs entirely. When provided, no
	 * `dockerContainer` runner is created — each node becomes a pure
	 * transformer publishing the supplied URL. Length must match
	 * `nodeCount` (or `nodeCount` is inferred from this array). Useful
	 * for tests and when nodes are managed externally. The deploy +
	 * register steps are also skipped in this mode. */
	rpcUrls?: string[];
}

export interface WalrusNodeState {
	index: number;
	rpcUrl: string;
}

export interface WalrusNetworkState {
	nodeCount: number;
	urls: string[];
}

export interface WalrusDeployState {
	/** Absolute path on host that holds the deploy outputs (yaml configs
	 * + the `deploy` summary file). Bind-mounted into the deploy
	 * container (rw) and into each storage node container (ro) by the
	 * walrus plugin. */
	outputDir: string;
	walrusPackageId: string;
	systemObject: string;
	stakingObject: string;
	upgradeManagerObject?: string;
	treasuryObject?: string;
	exchangeObject?: string;
}

export interface WalrusRegisterState {
	package: Package;
	systemObject: string;
	stakingObject: string;
	upgradeManagerObject?: string;
	treasuryObject?: string;
	exchangeObject?: string;
}

export interface WalrusExchangeState {
	/** Exchange object id (from `walrus.register.exchangeObject`). */
	objectId: string;
	/** Package id of the wal_exchange Move package — different from the
	 * walrus package id (the exchange ships in a separate `wal_exchange`
	 * package). Discovered by reading the exchange object's `type` and
	 * splitting on `::`. */
	packageId: string;
	/** Fully qualified WAL coin type (`<walrusPackageId>::wal::WAL`).
	 * Convenience for consumers that need to query / type-tag balances
	 * — derived from the walrus package id, not the exchange's. */
	walType: string;
	/** When the chain lookup resolved. Folds into the producer's
	 * identity so a fresh deploy (new exchange object) cascades into
	 * `walrus.seedWal.<name>` re-runs. */
	resolvedAt: number;
}

const nodeProvides = {
	rpc: dep((s: WalrusNodeState) => ({ url: s.rpcUrl })),
	full: dep((s: WalrusNodeState) => s),
} satisfies Provides<WalrusNodeState>;

const networkProvides = {
	urls: dep((s: WalrusNetworkState) => s.urls),
	full: dep((s: WalrusNetworkState) => s),
} satisfies Provides<WalrusNetworkState>;

const deployProvides = {
	full: dep((s: WalrusDeployState) => s),
	outputDir: dep((s: WalrusDeployState) => s.outputDir),
	packageId: dep((s: WalrusDeployState) => s.walrusPackageId),
} satisfies Provides<WalrusDeployState>;

const registerProvides = {
	package: dep((s: WalrusRegisterState) => s.package),
	full: dep((s: WalrusRegisterState) => s),
} satisfies Provides<WalrusRegisterState>;

const exchangeProvides = {
	full: dep((s: WalrusExchangeState) => s),
	objectId: dep((s: WalrusExchangeState) => s.objectId),
	packageId: dep((s: WalrusExchangeState) => s.packageId),
	walType: dep((s: WalrusExchangeState) => s.walType),
} satisfies Provides<WalrusExchangeState>;

// `walrus({ nodeCount })` — multi-node walrus testbed.
//
// Returns `{ nodes, appNetwork, deploy? }`:
//   - `nodes[i]`: pure-transformer producer named `walrus.node-${i}`
//     wrapping a private `dockerContainer({...})`.
//   - `appNetwork`: aggregator producer `walrus.app-network` whose
//     `deps:` is the array of every node's `full` view.
//   - `deploy`: present when running against the bundled image (i.e.
//     not in `rpcUrls:` mode). A pair of producers:
//       `walrus.deploy.container` — `dockerOneShot` that runs
//                                   `/opt/walrus/scripts/deploy-walrus.sh`
//                                   with sui + walrus env + a host
//                                   bind-mount for outputs.
//       `walrus.deploy`           — transformer that reads the
//                                   container's outputs file and parses
//                                   it into `WalrusDeployState`.
//
// Without an `image:` override, two `dockerImage` producers are wired
// into the graph:
//   - `walrus.image.upstream` — cargo-builds walrus + walrus-node +
//     walrus-deploy from the pinned WALRUS_VERSION via a BuildKit
//     `walrus-src` named context (no host clone needed).
//   - `walrus.image` — wrapper that bakes a matching sui binary +
//     forked deploy.sh / run.sh on top of the upstream tag.
// Each storage node container chains the wrapper tag, so a build-arg
// bump (walrus version, sui version, Dockerfile edit) flips both
// images' content-addressed identity → container input hash → recreate.
//
// Static usage:
//   const w = walrus({ nodeCount: 3 });
//   defineDevstackConfig({ stack: [sui.create({ network: 'localnet' }), w.appNetwork] });
//
// Test / external-management usage:
//   walrus({ rpcUrls: ['http://node0/', 'http://node1/'] }) — each node
//   becomes a pure transformer publishing the supplied URL with no
//   container, no port allocation, no deploy step. Mirrors the
//   `sui({ rpcUrl })` escape hatch.
export function walrus(opts: WalrusOptions = {}) {
	const rpcUrls = opts.rpcUrls;
	if (rpcUrls !== undefined && opts.nodeCount !== undefined && rpcUrls.length !== opts.nodeCount) {
		throw new Error(
			`walrus: rpcUrls length (${rpcUrls.length}) must equal nodeCount (${opts.nodeCount})`,
		);
	}
	const nodeCount = rpcUrls?.length ?? opts.nodeCount ?? 1;
	if (nodeCount < 1) {
		throw new Error('walrus: nodeCount must be at least 1');
	}
	const shards = opts.shards ?? DEFAULT_SHARDS;
	if (shards < nodeCount) {
		throw new Error(`walrus: shards (${shards}) must be >= nodeCount (${nodeCount})`);
	}

	const image = rpcUrls !== undefined ? undefined : resolveImage(opts);
	const deploy =
		rpcUrls !== undefined ? undefined : buildDeploy({ image: image!, opts, nodeCount, shards });
	const register = deploy !== undefined ? buildRegister(deploy) : undefined;
	const exchange = register !== undefined ? buildExchange(register) : undefined;

	const nodes = Array.from({ length: nodeCount }, (_, i) =>
		rpcUrls !== undefined
			? staticNode(i, rpcUrls[i]!)
			: containerNode(i, opts, image!, deploy!),
	);

	const appNetDeps = { nodes: nodes.map((n) => n.get('full')) };
	const appNetwork = define({
		name: 'walrus.app-network',
		deps: appNetDeps,
		provides: networkProvides,
		inputs: ({ deps }) => ({ urls: deps.nodes.map((n) => n.rpcUrl).sort() }),
		start: async ({ deps: { nodes: fulls } }): Promise<WalrusNetworkState> => ({
			nodeCount: fulls.length,
			urls: fulls.map((n) => n.rpcUrl),
		}),
		represents: {
			endpoints: (s: WalrusNetworkState): Endpoint[] =>
				s.urls.map((url, i) => ({ name: `walrus-node-${i}`, url, kind: 'walrus-node' })),
		},
	});

	return { nodes, appNetwork, deploy, register, exchange };
}

type ImageRef = string | Dep<void, string>;

function resolveImage(opts: WalrusOptions): ImageRef {
	if (opts.image !== undefined) return opts.image;
	const version = opts.version ?? WALRUS_DEFAULT_VERSION;
	const suiVersion = opts.suiVersion ?? SUI_DEFAULT_VERSION;

	const upstream = dockerImage({
		name: 'walrus.image.upstream',
		context: { path: DOCKER_CONTEXT },
		dockerfile: 'upstream.Dockerfile',
		args: {
			WALRUS_TAG: version,
			RUST_TOOLCHAIN: WALRUS_RUST_TOOLCHAIN,
			// `walrus_utils::bin_version!` reads `env!("GIT_REVISION")`
			// at compile time; the BuildKit named context flat-copies
			// without `.git`, so embed the release tag here.
			GIT_REVISION: version,
		},
		buildContexts: { 'walrus-src': { repo: WALRUS_REPO, rev: version } },
	});

	const wrapper = dockerImage({
		name: 'walrus.image',
		context: { path: DOCKER_CONTEXT },
		dockerfile: 'wrapper.Dockerfile',
		deps: { upstream: upstream.get('tag') },
		args: ({ deps }) => ({ BASE_IMAGE: deps.upstream, SUI_VERSION: suiVersion }),
	});
	return wrapper.get('tag');
}

interface DeploySteps {
	deploy: ReturnType<typeof define<WalrusDeployState, typeof deployProvides, any>>;
	hostDir: (env: { appDir: string; stack?: string }) => string;
}

function buildDeploy(args: {
	image: ImageRef;
	opts: WalrusOptions;
	nodeCount: number;
	shards: number;
}): DeploySteps {
	const epochDuration = args.opts.epochDuration ?? DEFAULT_EPOCH_DURATION;
	const restApiPort = args.opts.containerApiPort ?? DEFAULT_NODE_API_PORT;
	const publicHosts = Array.from({ length: args.nodeCount }, (_, i) => walrusPublicHost(i)).join(' ');

	// In-network address the deploy script targets — the per-(app, stack)
	// docker network's `sui-localnet` alias resolves to the sui-localnet
	// container's container-port 9000 (RPC) / 9123 (faucet). Hard-coded
	// container ports because we're addressing the container directly,
	// not the host-port-forwarded URL.
	const SUI_IN_NETWORK_RPC = `http://${SUI_LOCALNET_NETWORK_ALIAS}:9000`;
	const SUI_IN_NETWORK_FAUCET = `http://${SUI_LOCALNET_NETWORK_ALIAS}:9123`;

	const deployContainer = dockerOneShot({
		name: 'walrus.deploy.container',
		runsAs: 'walrus-deploy',
		image: typeof args.image === 'string' ? args.image : args.image,
		// Couple to sui (rpc/faucet) so the deploy step gates on the
		// localnet being live; the actual URLs come from the in-network
		// alias below — sui's host-port mappings aren't reachable from
		// inside the deploy container. `_octet` flows the per-(app,
		// stack) subnet's second octet so WALRUS_LISTENING_IPS pins to
		// the same `10.<octet>.0.10..` block storage nodes claim via
		// `--ip` below.
		deps: {
			_rpc: sui.get('rpc'),
			_faucet: sui.get('faucet'),
			_octet: dockerNetwork.get('octet'),
		},
		network: dockerNetwork.get('name'),
		volumes: ({ env }) => {
			const hostDir = walrusDeployHostDir(env);
			mkdirSync(hostDir, { recursive: true });
			return [{ host: hostDir, container: '/opt/walrus/outputs' }];
		},
		containerEnv: ({ deps }) => ({
			WALRUS_PUBLIC_HOSTS: publicHosts,
			// IPAM-pinned committee subnet — each storage node's
			// `dockerContainer.ip` resolves to the matching slot below
			// so deploy-time config + runtime listening IPs agree.
			WALRUS_LISTENING_IPS: Array.from({ length: args.nodeCount }, (_, i) =>
				walrusNodeIp(deps._octet, i),
			).join(' '),
			WALRUS_REST_API_PORT: String(restApiPort),
			WALRUS_COMMITTEE_SIZE: String(args.nodeCount),
			WALRUS_SHARDS: String(args.shards),
			WALRUS_EPOCH_DURATION: epochDuration,
			WALRUS_NETWORK: `${SUI_IN_NETWORK_RPC};${SUI_IN_NETWORK_FAUCET}/gas`,
		}),
		args: ['/bin/bash', '-c', '/opt/walrus/scripts/deploy-walrus.sh'],
	});

	const deploy = define<WalrusDeployState, typeof deployProvides>({
		name: 'walrus.deploy',
		deps: { c: deployContainer.get('full') },
		provides: deployProvides,
		start: async ({ env }) => {
			const hostDir = walrusDeployHostDir(env);
			const text = readFileSync(resolve(hostDir, 'deploy'), 'utf8');
			return { ...parseDeployFile(text), outputDir: hostDir };
		},
	});

	return { deploy, hostDir: walrusDeployHostDir };
}

// `walrus.register` is a projection of `walrus.deploy`'s parsed state
// into well-typed shapes (Package + the captured object IDs) downstream
// consumers — manifest, bindings, codegen — pivot on. The on-chain
// publish + node registration happens inside the deploy container's
// `walrus-deploy deploy-system-contract` invocation; we don't redo
// either step from TS. The dep on `sui.get('rpc')` is reserved for
// future enhancement (e.g. fetching the WAL coin type from chain to
// emit a CoinToken shape) — kept here so the register step gates on
// sui being live.
function buildRegister(deploy: DeploySteps) {
	return define<WalrusRegisterState, typeof registerProvides>({
		name: 'walrus.register',
		deps: { deploy: deploy.deploy.get('full'), rpc: sui.get('rpc') },
		provides: registerProvides,
		start: async ({ deps }) => {
			const d = (deps as { deploy: WalrusDeployState }).deploy;
			const pkg: Package = {
				name: 'walrus',
				packageId: d.walrusPackageId,
				mvrPlaceholder: '@local/walrus',
			};
			const out: WalrusRegisterState = {
				package: pkg,
				systemObject: d.systemObject,
				stakingObject: d.stakingObject,
			};
			if (d.upgradeManagerObject !== undefined) out.upgradeManagerObject = d.upgradeManagerObject;
			if (d.treasuryObject !== undefined) out.treasuryObject = d.treasuryObject;
			if (d.exchangeObject !== undefined) out.exchangeObject = d.exchangeObject;
			return out;
		},
		represents: {
			packages: (s: WalrusRegisterState): Package[] => [s.package],
		},
	});
}

// `walrus.exchange` — chain-discovery transformer. The exchange object
// id is in `walrus.register` (parsed out of the deploy file), but the
// exchange Move package's id is NOT — it ships as a separate
// `wal_exchange` package. Discover the package id by reading the
// exchange object's `.type` field and splitting on `::`. Cached as a
// graph node so per-account `walrus.seedWal.<name>` producers all
// share the single RPC round-trip; an upstream deploy bump cascades
// into a fresh resolution.
function buildExchange(register: ReturnType<typeof buildRegister>): Producer<WalrusExchangeState, typeof exchangeProvides> {
	return define<WalrusExchangeState, typeof exchangeProvides>({
		name: 'walrus.exchange',
		deps: { register: register.get('full'), rpc: sui.get('rpc') },
		provides: exchangeProvides,
		start: async ({ deps }) => {
			const d = deps as { register: WalrusRegisterState; rpc: { url: string } };
			const exchangeObjectId = d.register.exchangeObject;
			if (exchangeObjectId === undefined) {
				throw new Error(
					'walrus.exchange: register.exchangeObject is missing — was the deploy run with `--with-wal-exchange`?',
				);
			}
			const client = new SuiJsonRpcClient({ url: d.rpc.url, network: 'localnet' });
			const objectInfo = await client.core.getObject({ objectId: exchangeObjectId });
			const exchangeType = objectInfo.object.type;
			const packageId = exchangeType.split('::')[0];
			if (packageId === undefined || !packageId.startsWith('0x')) {
				throw new Error(
					`walrus.exchange: unexpected exchange object type "${exchangeType}" — expected "<pkg>::wal_exchange::Exchange"`,
				);
			}
			return {
				objectId: exchangeObjectId,
				packageId,
				// Convention: WAL ships in the main walrus package as
				// `<walrusPackageId>::wal::WAL`. Hardcoded module/struct
				// names match upstream's source layout.
				walType: `${d.register.package.packageId}::wal::WAL`,
				resolvedAt: Date.now(),
			};
		},
	});
}

function containerNode(index: number, opts: WalrusOptions, image: ImageRef, deploy: DeploySteps) {
	const containerApiPort = opts.containerApiPort ?? DEFAULT_NODE_API_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const slot = `walrus.node-${index}.api`;

	const container = dockerContainer({
		name: `walrus.node-${index}.container`,
		runsAs: `walrus-${index}`,
		image,
		ports: [{ slot, containerPort: containerApiPort }],
		readyTimeoutMs,
		// Join the per-(app, stack) docker network with a fixed IP +
		// alias matching `walrusPublicHost(index)`. The IP comes from
		// `dockerNetwork.octet` so the per-stack second octet matches
		// the deploy step's `WALRUS_LISTENING_IPS` exactly. The alias
		// (`walrus-node-<i>.localhost`) matches the on-chain registered
		// public host so other in-network containers (deploy script,
		// proxy) reach the node by the same name the chain knows.
		network: dockerNetwork.get('name'),
		networkAlias: walrusPublicHost(index),
		deps: { _octet: dockerNetwork.get('octet') },
		ip: ({ deps }) => walrusNodeIp(deps._octet, index),
		// Mount deploy outputs read-only — run.sh inside the container
		// reads its keystore + per-node yaml from /opt/walrus/outputs.
		volumes: ({ env }) => [
			{ host: deploy.hostDir(env), container: '/opt/walrus/outputs' },
		],
		// Storage-node RocksDB lives in the writable layer (the
		// container is the single writer). Pause-commit captures it
		// consistently; restore lets the committee come back online
		// without re-syncing from the deploy step.
		snapshot: { commit: true, quiesce: 'pause' },
	});

	return define({
		name: `walrus.node-${index}`,
		// `_deploy` couples the node to the deploy step's identity even
		// when the node container could in principle reuse a prior
		// running container — a fresh deploy must fan out to a node
		// recreation.
		deps: {
			apiPort: container.get('hostPort', { slot }),
			_deploy: deploy.deploy.get('full'),
		},
		provides: nodeProvides,
		start: async ({ deps: { apiPort } }): Promise<WalrusNodeState> => ({
			index,
			rpcUrl: `http://127.0.0.1:${apiPort}`,
		}),
		represents: {
			endpoints: (s: WalrusNodeState): Endpoint[] => [
				{ name: `walrus-node-${s.index}`, url: s.rpcUrl, kind: 'walrus-node' },
			],
		},
	});
}

function staticNode(index: number, rpcUrl: string) {
	return define({
		name: `walrus.node-${index}`,
		provides: nodeProvides,
		start: async (): Promise<WalrusNodeState> => ({ index, rpcUrl }),
		represents: {
			endpoints: (s: WalrusNodeState): Endpoint[] => [
				{ name: `walrus-node-${s.index}`, url: s.rpcUrl, kind: 'walrus-node' },
			],
		},
	});
}

// Per-stack host path that holds the walrus deploy outputs. Bind-mounted
// into the deploy container (rw) and into each storage-node container
// (ro) so run.sh reads its per-node config from the same place.
export function walrusDeployHostDir(env: { appDir: string; stack?: string }): string {
	return resolve(env.appDir, '.devstack', 'stacks', env.stack ?? 'default', 'walrus', 'deploy');
}

// Per-stack host path that holds the generated nginx config for
// `walrusProxy`. Mirrors `walrusDeployHostDir` — both live under
// `<stackDir>/walrus/...`. Bind-mounted read-only into the nginx
// container as `/etc/nginx/nginx.conf`.
export function walrusProxyConfigPath(env: { appDir: string; stack?: string }): string {
	return resolve(env.appDir, '.devstack', 'stacks', env.stack ?? 'default', 'walrus', 'proxy', 'nginx.conf');
}

/** Public hostname registered on chain. `*.localhost` resolves to
 * 127.0.0.1 on the host (RFC 6761); a matching docker network alias
 * on each node container handles the in-network case so `walrus-node-
 * <i>.localhost` resolves both ways. */
function walrusPublicHost(index: number): string {
	return `walrus-node-${index}.localhost`;
}

/** Per-storage-node fixed IP within the per-stack `/24`. Slots 10..
 * leave room at the bottom of the subnet for sui-localnet,
 * sui-indexer-db, and ad-hoc scratch containers (docker assigns those
 * dynamically when no `--ip` is set). 4-node committee occupies
 * `10.<octet>.0.10..13`. */
function walrusNodeIp(octet: number, index: number): string {
	return `10.${octet}.0.${10 + index}`;
}

export interface WalrusSeedWalAccount {
	/** Display name surfaced in the producer name (`walrus.seedWal.<name>`)
	 * and result state. Doesn't have to match the accounts plugin's
	 * spec key, but conventionally does. */
	name: string;
	/** Signer Dep — typically `accounts.pool.get('signer', { name })`. */
	signer: Dep<unknown, Keypair>;
}

export interface WalrusSeedWalOptions {
	/** `walrus.exchange` producer (from `walrus({...}).exchange!`). The
	 * helper Deps on its `full` view so per-account txs share the
	 * single chain lookup. */
	exchange: Producer<WalrusExchangeState, typeof exchangeProvides>;
	/** Accounts to seed. One producer is materialized per entry; failures
	 * are isolated per-account. */
	accounts: WalrusSeedWalAccount[];
	/** SUI to swap into WAL on each account, in MIST. Default 1 SUI
	 * (1_000_000_000n). The exchange's pricing decides the WAL out;
	 * a tiny amount is enough for any reasonable blob upload session. */
	paymentMist?: bigint;
}

export interface WalrusSeedWalAccountState {
	name: string;
	address: string;
	digest: string;
	paymentMist: string;
	seededAt: number;
}

const DEFAULT_SEED_WAL_PAYMENT_MIST = 1_000_000_000n;

// `walrusSeedWal({...})` — bundle of per-account seed transactions that
// swap SUI for WAL on the testbed's `Exchange` so apps can upload blobs
// without manual `walrus get-wal` calls.
//
// Returns one `runTransaction` producer per declared account, named
// `tx.walrus.seedWal.<name>`. Each:
//   - Deps on its signer + the shared `walrus.exchange` info producer
//     (so the on-chain exchange-package-id lookup happens once).
//   - Builds an `exchange_all_for_wal` Move call paying `paymentMist`
//     SUI sourced via `tx.coin({ useGasCoin: false })` (address-balance
//     preferred), transfers the resulting WAL coin to the signer.
//   - Persists `{ name, address, digest, paymentMist, seededAt }`.
//
// Failure isolation: a per-account producer's error is scoped to that
// node — the rest of the cycle proceeds. The engine's runsAs key is
// `<name>` so two seed steps for the same account serialize naturally
// (rare in practice; common case is one signer per account).
//
// Idempotency: each producer's identity folds in the exchange info,
// signer, payment amount, and rpc url. Stable inputs → engine skips
// the run. A fresh deploy invalidates `walrus.exchange` → cascades into
// every per-account seed.
export function walrusSeedWal(opts: WalrusSeedWalOptions) {
	if (opts.accounts.length === 0) {
		throw new Error('walrusSeedWal: at least one account is required');
	}
	const seenNames = new Set<string>();
	for (const acc of opts.accounts) {
		if (!acc.name) throw new Error('walrusSeedWal: account `name` is required');
		if (seenNames.has(acc.name)) {
			throw new Error(`walrusSeedWal: duplicate account name "${acc.name}"`);
		}
		seenNames.add(acc.name);
	}

	const paymentMist = opts.paymentMist ?? DEFAULT_SEED_WAL_PAYMENT_MIST;
	if (paymentMist <= 0n) {
		throw new Error(`walrusSeedWal: paymentMist must be positive (got ${paymentMist})`);
	}

	return opts.accounts.map((acc) =>
		runTransaction({
			name: `walrus.seedWal.${acc.name}`,
			signer: acc.signer,
			deps: { exchange: opts.exchange.get('full') },
			// Fold paymentMist into the input hash so a bumped amount
			// re-fires; signer-identity changes already cascade via the
			// signer Dep.
			inputs: () => ({ paymentMist: paymentMist.toString() }),
			build: async ({ signer, rpcUrl, deps }) => {
				const exchange = deps.exchange;
				const tx = new Transaction();
				// `useGasCoin: false` lets the SDK pull from address-
				// balance if available, falling back to owned coins.
				// Keeps the helper agnostic of the funding source the
				// accounts plugin chose (faucet-only vs AB-deposit).
				const paymentCoin = tx.coin({
					balance: paymentMist,
					type: '0x2::sui::SUI',
					useGasCoin: false,
				});
				const walCoin = tx.moveCall({
					target: `${exchange.packageId}::wal_exchange::exchange_all_for_wal`,
					arguments: [tx.object(exchange.objectId), paymentCoin],
				});
				const address = signer.toSuiAddress();
				tx.transferObjects([walCoin], tx.pure.address(address));
				const client = new SuiJsonRpcClient({ url: rpcUrl, network: 'localnet' });
				const result = await client.signAndExecuteTransaction({
					signer,
					transaction: tx,
					options: { showEffects: true },
				});
				if (result.effects?.status.status !== 'success') {
					throw new Error(
						`walrus.seedWal.${acc.name}: failed: ${result.effects?.status.error ?? 'unknown'}`,
					);
				}
				await client.waitForTransaction({ digest: result.digest });
				const seedState: WalrusSeedWalAccountState = {
					name: acc.name,
					address,
					digest: result.digest,
					paymentMist: paymentMist.toString(),
					seededAt: Date.now(),
				};
				return seedState;
			},
		}),
	);
}

export interface WalrusProxyOptions {
	/** Walrus storage-node producers — typically `walrus({...}).nodes`.
	 * The proxy gates on each node's `full` state (so nginx starts only
	 * after the committee is up) and dispatches by `Host:
	 * walrus-node-<i>.localhost` headers, deriving the per-node alias
	 * from each node's `index`. Empty-array → throws (proxy with no
	 * upstreams is meaningless). */
	nodes: Producer<WalrusNodeState, typeof nodeProvides>[];
	/** Container port the storage nodes listen on inside the per-stack
	 * network. nginx listens on the same port so the upstream
	 * `proxy_pass` is symmetric. Default `DEFAULT_NODE_API_PORT` (9185).
	 * Match this to the `containerApiPort:` you passed to `walrus({...})`. */
	nodePort?: number;
	/** Ready-probe timeout. Default 30s. */
	readyTimeoutMs?: number;
}

export interface WalrusProxyState {
	url: string;
	port: number;
}

const proxyProvides = {
	url: dep((s: WalrusProxyState) => s.url),
	full: dep((s: WalrusProxyState) => s),
} satisfies Provides<WalrusProxyState>;

// `walrusProxy({...})` — single-host-port nginx vhost in front of an
// N-node committee. Returns one transformer producer
// (`walrus.proxy`) backed by a private `walrus.proxy.container`
// dockerContainer (graph sibling for snapshot / lifecycle uniformity).
//
// Why a proxy at all when each storage-node container already maps a
// host port? Two reasons:
//   - A single allocated host port keeps app-side wiring stable across
//     committee resizes.
//   - SDK clients that key on `Host: walrus-node-<i>.localhost` (the
//     names the nodes register on chain) get one URL to reach all of
//     them — the alternative is N per-node URLs in the manifest.
//
// Wiring details:
//   - nginx listens on `nodePort` inside the container; the host port
//     is allocated via the standard `ports` node.
//   - The container joins `dockerNetwork` with alias
//     `walrus-proxy.localhost`; vhost upstreams pass to each node's
//     `10.<octet>.0.<10+i>:<nodePort>` directly (deterministic IPs from
//     5e — no DNS hop). Octet flows in via `dockerNetwork.get('octet')`
//     so the generated config tracks the per-(app, stack) subnet.
//   - The config is written to `<stackDir>/walrus/proxy/nginx.conf` at
//     start-time and bind-mounted read-only into the container. Same
//     pattern walrus.deploy.container uses for its outputs file.
//
// Identity / re-runs: each node's `full` Dep flows in, so a recreated
// node (image bump, octet flip, deploy-driven invalidation) cascades
// into the proxy's input hash — nginx restarts on the new node identity.
export function walrusProxy(opts: WalrusProxyOptions) {
	if (opts.nodes.length === 0) {
		throw new Error('walrusProxy: at least one node is required');
	}
	const nodePort = opts.nodePort ?? DEFAULT_NODE_API_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
	const slot = 'walrus.proxy';

	const proxyContainer = dockerContainer({
		name: 'walrus.proxy.container',
		runsAs: 'walrus-proxy',
		image: 'nginx:alpine',
		network: dockerNetwork.get('name'),
		networkAlias: 'walrus-proxy.localhost',
		// `_octet` flows into the volumes callback for IP-based
		// upstream pass-through; `_nodes` gates on the committee being
		// up (any node identity flip cascades through here).
		deps: {
			_octet: dockerNetwork.get('octet'),
			_nodes: opts.nodes.map((n) => n.get('full')),
		},
		ports: [{ slot, containerPort: nodePort }],
		readyTimeoutMs,
		volumes: ({ env, deps }) => {
			const indices = deps._nodes.map((n) => n.index).sort((a, b) => a - b);
			const config = renderWalrusProxyConfig({
				octet: deps._octet,
				nodeIndices: indices,
				nodePort,
			});
			const path = walrusProxyConfigPath(env);
			mkdirSync(resolve(path, '..'), { recursive: true });
			writeFileSync(path, config, 'utf8');
			return [{ host: path, container: '/etc/nginx/nginx.conf' }];
		},
		// Folds inputs that the volumes side-effect depends on into the
		// container's input hash so a node-count change or octet flip
		// flips the container identity → recreate.
		inputs: ({ deps }) => {
			const resolved = deps as { _octet: number; _nodes: WalrusNodeState[] };
			return {
				octet: resolved._octet,
				nodeIndices: resolved._nodes.map((n) => n.index).sort((a, b) => a - b),
				nodePort,
			};
		},
		readyProbe: async ({ hostPorts }) => {
			const port = hostPorts[slot];
			if (port === undefined) return false;
			// Hit the proxy with a known Host. Even if the upstream
			// returns 502 (node still booting), nginx itself answering
			// any HTTP response is enough to declare ready — we already
			// gated on the nodes' `full` state via deps so this is just
			// confirming nginx loaded its config.
			return await probeProxy(port, walrusPublicHost(0));
		},
	});

	const proxyDeps = { hostPort: proxyContainer.get('hostPort', { slot }) };
	return define<WalrusProxyState, typeof proxyProvides, typeof proxyDeps>({
		name: 'walrus.proxy',
		deps: proxyDeps,
		provides: proxyProvides,
		start: async ({ deps: { hostPort } }): Promise<WalrusProxyState> => ({
			url: `http://127.0.0.1:${hostPort}`,
			port: hostPort,
		}),
		represents: {
			endpoints: (s: WalrusProxyState): Endpoint[] => [
				{ name: 'walrus-proxy', url: s.url, kind: 'walrus-proxy' },
			],
		},
	});
}

/** Render the nginx config that fronts an N-node walrus committee on
 * a single port via Host-header vhost routing. Pure; testable in
 * isolation. The string format is stable so the input-hash machinery
 * can fold it through `inputs:` rather than diffing the file. */
export function renderWalrusProxyConfig(opts: {
	octet: number;
	nodeIndices: number[];
	nodePort: number;
}): string {
	const servers = opts.nodeIndices
		.map((idx) => {
			const upstream = walrusNodeIp(opts.octet, idx);
			const serverName = walrusPublicHost(idx);
			return `	server {
		listen 0.0.0.0:${opts.nodePort};
		server_name ${serverName};
		location / {
			proxy_pass http://${upstream}:${opts.nodePort};
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
}

async function probeProxy(hostPort: number, hostHeader: string): Promise<boolean> {
	try {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const exec = promisify(execFile);
		// `--max-time 2` so a hung upstream doesn't wedge the probe
		// loop. Any 2xx/4xx/5xx counts as "nginx is up"; only
		// connection-refused / timeout fails the probe.
		await exec('curl', [
			'-sS',
			'-o',
			'/dev/null',
			'--max-time',
			'2',
			'-H',
			`Host: ${hostHeader}`,
			`http://127.0.0.1:${hostPort}/`,
		]);
		return true;
	} catch {
		return false;
	}
}

export function parseDeployFile(text: string): Omit<WalrusDeployState, 'outputDir'> {
	const get = (key: string): string | undefined => {
		const m = text.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'));
		const value = m?.[1];
		if (value === undefined || value === 'None') return undefined;
		return value;
	};
	const walrusPackageId = get('package_id');
	const systemObject = get('system_object');
	const stakingObject = get('staking_object');
	if (walrusPackageId === undefined || systemObject === undefined || stakingObject === undefined) {
		throw new Error(
			`walrus.deploy: deploy file missing one of {package_id, system_object, staking_object}:\n${text.slice(0, 400)}`,
		);
	}
	const out: Omit<WalrusDeployState, 'outputDir'> = {
		walrusPackageId,
		systemObject,
		stakingObject,
	};
	const upgradeManagerObject = get('upgrade_manager_object');
	if (upgradeManagerObject !== undefined) out.upgradeManagerObject = upgradeManagerObject;
	const treasuryObject = get('treasury_object');
	if (treasuryObject !== undefined) out.treasuryObject = treasuryObject;
	const exchangeObject = get('exchange_object');
	if (exchangeObject !== undefined) out.exchangeObject = exchangeObject;
	return out;
}
