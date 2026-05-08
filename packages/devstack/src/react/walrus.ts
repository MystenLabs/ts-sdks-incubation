// Walrus integration helpers.
//
// On localnet, the on-chain Walrus Committee registers each storage
// node as `walrus-node-<idx>.localhost:<sharedPort>`. The `*.localhost`
// reservation (RFC 6761) makes that string resolvable to 127.0.0.1
// from any modern OS resolver / browser, so the same URL works from a
// host browser (→ host port → walrus.proxy nginx vhost-routes by
// `Host:` → upstream docker IP) and from inside the docker network (→
// network alias on each storage-node container → direct).
//
// What still doesn't line up is the scheme: the walrus TS SDK
// hardcodes `https://${node_info.network_address}` at
// `WalrusClient#getCommittee`, but our storage nodes serve plain HTTP
// (axum-server 0.8.0 panics on the self-signed handshake on
// arm64-darwin, so devstack disables TLS via `tls.disable_tls: true`
// in each per-node yaml). Until the upstream `storageNodeUrlScheme`
// option ships in `@mysten/walrus`, we plumb a fetch override that
// rewrites the SDK's outbound storage-node URLs from `https://` to
// `http://`. The override only sees storage-node URLs because it's
// scoped via `storageNodeClientOptions.fetch` (the SDK's
// upload-relay / sui-RPC paths use different fetch instances), so an
// unconditional scheme swap is safe.
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

interface DevstackManifestShape {
	registry?: {
		packages?: Array<{
			name: string;
			packageId: string;
			captured?: Record<string, string>;
		}>;
	};
}

export interface LocalnetWalrusOptions {
	/** `systemObjectId` + `stakingPoolId` for `WalrusClient`. Read from
	 * the manifest's `walrus` package `captured` fields. */
	packageConfig: { systemObjectId: string; stakingPoolId: string };
	/** Fetch override that rewrites the storage-node SDK's outbound
	 * `https://` URLs to `http://`. Spread into the `WalrusClient`'s
	 * `storageNodeClientOptions`. */
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
 * — that means devstack hasn't brought walrus up yet.
 */
export function localnetWalrusOptions(
	manifest: unknown,
	init: LocalnetWalrusOptionsInit = {},
): LocalnetWalrusOptions {
	const m = manifest as DevstackManifestShape;
	const walrusPkg = m.registry?.packages?.find((p) => p.name === 'walrus');
	if (walrusPkg === undefined) {
		throw new Error(
			'localnetWalrusOptions: no `walrus` package in manifest. Has `devstack up` finished bringing walrus up?',
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
		storageNodeClientOptions: { fetch: makeHttpsToHttpFetch(baseFetch) },
	};
}

const HTTPS_PREFIX = 'https://';

function makeHttpsToHttpFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return ((input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.startsWith(HTTPS_PREFIX)) {
			return baseFetch(input as RequestInfo, init);
		}
		const rewritten = `http://${url.slice(HTTPS_PREFIX.length)}`;
		if (typeof input === 'string' || input instanceof URL) {
			return baseFetch(rewritten, init);
		}
		// Rebuild Request with the new URL — Request.url is read-only.
		return baseFetch(new Request(rewritten, input), init);
	}) as typeof globalThis.fetch;
}
