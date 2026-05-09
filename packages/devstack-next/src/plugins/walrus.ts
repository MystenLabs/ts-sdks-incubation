import { fileURLToPath } from 'node:url';
import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { dockerContainer } from '../runners/docker-container.js';
import { dockerImage } from '../runners/docker-image.js';
import type { Endpoint } from '../shapes/index.js';
import { SUI_DEFAULT_VERSION } from './sui.js';

const DEFAULT_NODE_API_PORT = 9185;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

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
	/** Override per-node RPC URLs entirely. When provided, no
	 * `dockerContainer` runner is created — each node becomes a pure
	 * transformer publishing the supplied URL. Length must match
	 * `nodeCount` (or `nodeCount` is inferred from this array). Useful
	 * for tests and when nodes are managed externally. */
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

const nodeProvides = {
	rpc: dep((s: WalrusNodeState) => ({ url: s.rpcUrl })),
	full: dep((s: WalrusNodeState) => s),
} satisfies Provides<WalrusNodeState>;

const networkProvides = {
	urls: dep((s: WalrusNetworkState) => s.urls),
	full: dep((s: WalrusNetworkState) => s),
} satisfies Provides<WalrusNetworkState>;

// `walrus({ nodeCount })` — multi-node walrus testbed.
//
// Returns `{ nodes, appNetwork }`:
//   - `nodes[i]`: pure-transformer producer named `walrus.node-${i}` that
//     depends on a private `dockerContainer({...})` for the actual
//     container lifecycle. Per the cross-cutting rule, plugins never
//     call docker directly from `start`; the runner exposes
//     `provides.state` + `provides.hostPort` so this transformer can
//     project a clean `WalrusNodeState`. Container nodes appear as
//     siblings in the graph (`walrus.node-${i}.container`) and
//     participate in snapshot / shutdown uniformly.
//
//   - `appNetwork`: aggregator producer named `walrus.app-network`
//     whose `deps:` is the array of every node's `full` view. Consumers
//     can depend on this alone instead of listing every node.
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
//   defineDevstackConfig({ stack: [w.appNetwork] });    // pulls in nodes
//
// Test / external-management usage:
//   walrus({ rpcUrls: ['http://node0/', 'http://node1/'] }) — each node
//   becomes a pure transformer publishing the supplied URL with no
//   container, no port allocation. Mirrors the `sui({ rpcUrl })` escape
//   hatch.
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

	const image = rpcUrls !== undefined ? undefined : resolveImage(opts);

	const nodes = Array.from({ length: nodeCount }, (_, i) =>
		rpcUrls !== undefined ? staticNode(i, rpcUrls[i]!) : containerNode(i, opts, image!),
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

	return { nodes, appNetwork };
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

function containerNode(index: number, opts: WalrusOptions, image: ImageRef) {
	const containerApiPort = opts.containerApiPort ?? DEFAULT_NODE_API_PORT;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const slot = `walrus.node-${index}.api`;

	const container = dockerContainer({
		name: `walrus.node-${index}.container`,
		runsAs: `walrus-${index}`,
		image,
		ports: [{ slot, containerPort: containerApiPort }],
		readyTimeoutMs,
	});

	return define({
		name: `walrus.node-${index}`,
		deps: { apiPort: container.get('hostPort', { slot }) },
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
