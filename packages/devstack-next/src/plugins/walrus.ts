import type { Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { dockerContainer } from '../runners/docker-container.js';
import type { Endpoint } from '../shapes/index.js';

const DEFAULT_WALRUS_IMAGE = 'mystenlabs/walrus-service:latest';
const DEFAULT_NODE_API_PORT = 9185;
const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface WalrusOptions {
	/** Number of storage nodes to spin up. Default 1. PLAN.md L6 sketches
	 * a 3-node committee as the canonical example. */
	nodeCount?: number;
	/** Override the storage-node image. Default
	 * `mystenlabs/walrus-service:latest`. */
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

	const nodes = Array.from({ length: nodeCount }, (_, i) =>
		rpcUrls !== undefined ? staticNode(i, rpcUrls[i]!) : containerNode(i, opts),
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

function containerNode(index: number, opts: WalrusOptions) {
	const image = opts.image ?? DEFAULT_WALRUS_IMAGE;
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
