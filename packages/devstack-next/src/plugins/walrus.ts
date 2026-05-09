import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
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

	return { nodes, appNetwork, deploy, register };
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
