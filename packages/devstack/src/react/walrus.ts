// Walrus integration helpers.
//
// On localnet, walrus storage nodes register themselves on chain with
// their internal docker-network IP (`https://10.0.0.10–13:9185`) — the
// URL nodes use to talk to each other. Browsers can't reach those IPs
// directly and the cert is self-signed, so the `walrus()` plugin
// publishes each node on a host port. The SDK still sees the docker
// IPs in the on-chain committee data; we plumb a fetch override that
// rewrites outbound URLs to the host-mapped plain-HTTP equivalents.
//
// `localnetWalrusOptions(manifest)` returns the localnet-specific
// pieces (`packageConfig` + `storageNodeClientOptions.fetch`) so app
// code can construct a vanilla `WalrusClient`:
//
//     const client = new WalrusClient({
//       suiClient,
//       ...localnetWalrusOptions(manifest),
//     });
//
// On testnet/mainnet, the same call site uses the SDK's built-in
// configuration without the override.


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

export interface LocalnetWalrusOptions {
	/** `systemObjectId` + `stakingPoolId` for `WalrusClient`. Read from
	 * the manifest's `walrus` package `captured` fields. */
	packageConfig: { systemObjectId: string; stakingPoolId: string };
	/** Fetch override that rewrites docker-internal storage-node URLs to
	 * the host-mapped plain-HTTP equivalents. Spread into the
	 * `WalrusClient`'s `storageNodeClientOptions`. */
	storageNodeClientOptions: { fetch: typeof globalThis.fetch };
}

export interface LocalnetWalrusOptionsInit {
	/** Optional base fetch — used in environments where the global
	 * `fetch` should be replaced (e.g. node, MSW). The override wraps
	 * this base. */
	fetch?: typeof globalThis.fetch;
}

/**
 * Localnet-specific config inputs for `new WalrusClient(...)`.
 *
 * Apps construct walrus directly:
 *
 *     const client = new WalrusClient({
 *       suiClient,
 *       ...localnetWalrusOptions(manifest),
 *       wasmUrl,  // app supplies its own wasm URL however it likes
 *     });
 *
 * Production code drops the spread and uses the SDK's built-in
 * defaults (or its own per-network overrides). The call shape is
 * structurally identical between localnet and prod — only the
 * config-input piece differs.
 *
 * Throws if the manifest is empty or doesn't carry a `walrus` package
 * + nodes — that means devstack hasn't brought walrus up yet.
 */
export function localnetWalrusOptions(
	manifest: unknown,
	init: LocalnetWalrusOptionsInit = {},
): LocalnetWalrusOptions {
	const m = manifest as DevstackManifestShape;
	const walrusPkg = m.registry?.packages?.find((p) => p.name === 'walrus');
	const nodes = m.registry?.walrus?.nodes ?? [];
	if (walrusPkg === undefined) {
		throw new Error(
			'localnetWalrusOptions: no `walrus` package in manifest. Has `pnpm localnet:up` finished bringing walrus up?',
		);
	}
	if (nodes.length === 0) {
		throw new Error(
			"localnetWalrusOptions: no walrus nodes in manifest. The `walrus.register` action probably hasn't completed.",
		);
	}
	const systemObjectId = walrusPkg.captured?.systemObject;
	const stakingPoolId = walrusPkg.captured?.stakingObject;
	if (systemObjectId === undefined || stakingPoolId === undefined) {
		throw new Error(
			'localnetWalrusOptions: walrus package missing systemObject/stakingObject in manifest.captured.',
		);
	}
	const baseFetch = init.fetch ?? globalThis.fetch.bind(globalThis);
	return {
		packageConfig: { systemObjectId, stakingPoolId },
		storageNodeClientOptions: { fetch: makeFetchOverride(baseFetch, nodes) },
	};
}

function makeFetchOverride(
	baseFetch: typeof globalThis.fetch,
	nodes: ReadonlyArray<DevstackWalrusNode>,
): typeof globalThis.fetch {
	// Match by host:port suffix instead of full URL prefix — the
	// on-chain Committee data baked at `walrus.deploy` time records
	// node addresses as `https://<ip>:9185` (TLS was the upstream
	// default), but the actual storage nodes run plain HTTP because
	// devstack disables TLS in their yaml (axum-server panic on
	// arm64-darwin). A scheme-locked match would let those `https://`
	// URLs pass through unmodified, leaving the browser to attempt
	// connections to docker-internal IPs that aren't reachable from
	// the host. Matching `://<ip>:9185` rewrites both schemes to the
	// host-mapped HTTP port the walrus.proxy nginx sidecar exposes.
	const rules = nodes.map((n) => {
		try {
			const parsed = new URL(n.apiUrl);
			return { hostPort: `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`, to: n.hostApiUrl };
		} catch {
			return { hostPort: n.apiUrl, to: n.hostApiUrl };
		}
	});
	return ((input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		for (const rule of rules) {
			const idx = url.indexOf(`://${rule.hostPort}`);
			if (idx > 0 && idx < 10) {
				// `://` lives at position 5 (`http`) or 6 (`https`); cap
				// at 10 to make sure we're matching the scheme
				// separator and not stray text. Suffix after the
				// host:port (path + query) is preserved.
				const tailStart = idx + 3 + rule.hostPort.length;
				const rewritten = rule.to + url.slice(tailStart);
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
