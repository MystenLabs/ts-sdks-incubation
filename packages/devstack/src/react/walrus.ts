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
// configuration without the override. The "create" wrapper below is
// kept for back-compat; new code should use the options helper +
// vanilla constructor.

import type { WalrusClient, WalrusClientConfig } from '@mysten/walrus';
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

export interface CreateDevstackWalrusClientOptions {
	/** Manifest from `virtual:devstack-manifest`. */
	manifest: unknown;
	/** Sui client used by the SDK for chain reads. Typically
	 * `useCurrentClient()` from dapp-kit-react. */
	suiClient: ClientWithCoreApi;
	/** Optional fetch override base, applied AFTER the host-URL rewrite. */
	fetch?: typeof globalThis.fetch;
	/** Walrus encoder WASM URL — pass through to `WalrusClient`. Optional;
	 * the SDK falls back to its own bundled wasm when omitted. */
	wasmUrl?: string;
}

/**
 * Convenience wrapper that constructs a `WalrusClient` against the
 * localnet manifest in one call.
 *
 * @deprecated Prefer the explicit shape so the call site stays
 * identical between localnet and production:
 *
 *     import { WalrusClient } from '@mysten/walrus';
 *     import { localnetWalrusOptions } from '@mysten-incubation/devstack/react';
 *
 *     const client = new WalrusClient({
 *       suiClient,
 *       ...localnetWalrusOptions(manifest),
 *       wasmUrl,
 *     });
 *
 * On mainnet/testnet, drop the spread; the rest of the call doesn't
 * change. See `notes/react-api-investigation.md` for the rationale.
 */
export async function createDevstackWalrusClient(
	opts: CreateDevstackWalrusClientOptions,
): Promise<WalrusClient> {
	const { WalrusClient } = await import('@mysten/walrus');
	const config: WalrusClientConfig = {
		suiClient: opts.suiClient,
		...localnetWalrusOptions(opts.manifest, { fetch: opts.fetch }),
		wasmUrl: opts.wasmUrl,
	};
	return new WalrusClient(config);
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
