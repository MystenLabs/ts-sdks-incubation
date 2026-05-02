// `createDevstackWalrusClient(opts)` — builds a `@mysten/walrus`
// `WalrusClient` against the live devstack manifest.
//
// The on-chain committee data registers each storage node with its
// internal docker-network IP (`https://10.0.0.10–13:9185`) — the URL
// nodes use to talk to each other. Browsers can't reach those IPs and
// the cert is self-signed, so the `walrus()` plugin runs an nginx
// sidecar (`walrus.proxy`) that terminates TLS and re-exposes each
// node as plain HTTP on a host port. This helper wires the SDK to use
// that proxy by overriding `storageNodeClientOptions.fetch` to rewrite
// the SDK's outbound URLs.

import type { WalrusClient } from '@mysten/walrus';
import type { ClientWithCoreApi } from '@mysten/sui/client';

interface DevstackWalrusNode {
	ip: string;
	apiUrl: string;
	hostApiUrl: string;
}

interface DevstackManifestShape {
	registry?: {
		packages?: Array<{
			name: string;
			packageId: string;
			captured?: Record<string, string>;
		}>;
		walrus?: {
			nodes?: DevstackWalrusNode[];
		};
	};
}

export interface CreateDevstackWalrusClientOptions {
	/** Manifest from `virtual:devstack-manifest`. */
	manifest: unknown;
	/** Sui client used by the SDK for chain reads. Typically
	 * `useCurrentClient()` from dapp-kit-react. */
	suiClient: ClientWithCoreApi;
	/** Optional fetch override base, applied AFTER the host-URL rewrite. */
	fetch?: typeof globalThis.fetch;
	/** Walrus encoder WASM URL. Browser apps that include
	 * `devstackVitePlugins()` get this auto-resolved from
	 * `virtual:devstack-walrus-wasm-url` (vite serves the bundled wasm at
	 * a stable path); pass an explicit value to override. */
	wasmUrl?: string;
}

/**
 * Build a {@link WalrusClient} configured against the local devstack
 * walrus deployment. Reads `systemObject` + `stakingObject` from the
 * manifest's walrus package entry, and installs a fetch override that
 * translates the on-chain node URLs (internal docker IPs) to the
 * host-mapped plain-HTTP proxy URLs the browser can actually reach.
 *
 * Throws if the manifest is empty or doesn't contain a walrus package /
 * nodes entry — that means devstack hasn't brought walrus up yet.
 */
export async function createDevstackWalrusClient(
	opts: CreateDevstackWalrusClientOptions,
): Promise<WalrusClient> {
	const { WalrusClient } = await import('@mysten/walrus');

	const manifest = opts.manifest as DevstackManifestShape;
	const walrusPkg = manifest.registry?.packages?.find((p) => p.name === 'walrus');
	const nodes = manifest.registry?.walrus?.nodes ?? [];
	if (walrusPkg === undefined) {
		throw new Error(
			'createDevstackWalrusClient: no `walrus` package in manifest. Has `pnpm localnet:up` finished bringing walrus up?',
		);
	}
	if (nodes.length === 0) {
		throw new Error(
			"createDevstackWalrusClient: no walrus nodes in manifest. The `walrus.register` action probably hasn't completed.",
		);
	}
	const systemObjectId = walrusPkg.captured?.systemObject;
	const stakingPoolId = walrusPkg.captured?.stakingObject;
	if (systemObjectId === undefined || stakingPoolId === undefined) {
		throw new Error(
			'createDevstackWalrusClient: walrus package missing systemObject/stakingObject in manifest.captured.',
		);
	}

	const baseFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
	const fetchOverride = makeFetchOverride(baseFetch, nodes);

	return new WalrusClient({
		suiClient: opts.suiClient,
		packageConfig: {
			systemObjectId,
			stakingPoolId,
		},
		storageNodeClientOptions: {
			fetch: fetchOverride,
		},
		wasmUrl: opts.wasmUrl,
	});
}

function makeFetchOverride(
	baseFetch: typeof globalThis.fetch,
	nodes: ReadonlyArray<DevstackWalrusNode>,
): typeof globalThis.fetch {
	const rules = nodes.map((n) => ({ from: n.apiUrl, to: n.hostApiUrl }));
	return ((input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		for (const rule of rules) {
			if (url.startsWith(rule.from)) {
				const rewritten = rule.to + url.slice(rule.from.length);
				if (typeof input === 'string' || input instanceof URL) {
					return baseFetch(rewritten, init);
				}
				// Rebuild Request with the new URL — Request.url is read-only.
				return baseFetch(new Request(rewritten, input), init);
			}
		}
		return baseFetch(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}
