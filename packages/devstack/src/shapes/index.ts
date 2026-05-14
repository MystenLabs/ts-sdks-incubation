// Shared shape types for cross-plugin fan-in. Plugins that publish their
// state into one of these categories should `represents:` it under the
// corresponding key (`packages`, `endpoints`, `accounts`) AND expose a
// typed Dep that returns the shape verbatim, so the `manifest` /
// `bindings` plugins and friends can consume them without a string-keyed
// registry.
//
// Plugins are free to define their own shape types beyond these — the
// engine doesn't care. These are the conventional defaults that the core
// manifest / bindings / TUI / observability tools pivot on.

export interface Package {
	/** Logical name (`'token'`, `'nft'`). Used as the bindings subdir. */
	name: string;
	/** On-chain object id of the published package. */
	packageId: string;
	/** MVR placeholder string (`'@local/<name>'` by convention). The
	 * `bindings` plugin emits `tx.moveCall({ package: '<placeholder>', … })`
	 * using this string; `localnetMvrOverrides(manifest)` reads it back to
	 * resolve the placeholder to a live `packageId` at transaction-build
	 * time. Set by `publishMove`; absent for packages that publish only a
	 * static address (e.g. canonical deepbook IDs on testnet/mainnet). */
	mvrPlaceholder?: string;
	/** Host-side path to the Move source. Set when the package was
	 * published from local source (`publishMove`); absent when source
	 * lives inside a docker image (upstream imports) or doesn't exist
	 * locally (canonical deepbook IDs). The `bindings` plugin uses this
	 * to find sources for `sui move summary`; the `manifest` plugin
	 * strips it before serializing so per-developer absolute paths
	 * don't leak into committed files. */
	path?: string;
	/** Secondary object ids surfaced by the publish (TreasuryCap,
	 * AdminCap, system / staking objects, etc.). Populated by
	 * `publishViaSuiCli`'s `capture:` callback or by plugins that own
	 * the publish flow (walrus, deepbook, seal). Frontends read this
	 * to thread cap ids into Move calls without re-fetching from
	 * chain. */
	captured?: Record<string, string>;
}

export interface Endpoint {
	/** Stable display name (`'sui-rpc'`, `'walrus-aggregator'`). */
	name: string;
	/** Full URL incl. scheme + host + port. */
	url: string;
	/** Optional category for grouping in the TUI / dashboard. */
	kind?: string;
	/** Pairing URL — the URL a developer clicks (or that the frontend
	 * parses) to extract a session token. Today only the `wallet-app`
	 * endpoint sets this: `<url>/?token=<hex>` matches the bearer token
	 * the devstack signer server checks on each `/api/v1/devstack/*`
	 * request. Other endpoints leave it absent. Localnet-only — the
	 * token is a per-stack random bytestring, never a real credential. */
	pairUrl?: string;
}

export interface Account {
	/** Logical name (`'publisher'`, `'minter'`). */
	name: string;
	/** Sui address (0x-prefixed hex). */
	address: string;
}

export interface Coin {
	/** Logical registry name (`'managed_coin'`, `'musdc'`). Matches the
	 * `name` argument passed to `registerCoin`. */
	name: string;
	/** Fully-qualified Move type: `${packageId}::${module}::${TYPE}`. */
	type: string;
	/** Coin decimals (e.g. 6 for USDC-shaped, 9 for SUI-shaped). */
	decimals: number;
}

// The standard manifest shape — what `manifest()` plugin emits and what
// vitest / playwright `readManifest()` returns. Generic over `TExtras`
// so apps that populate `extras` with a known shape can recover that
// typing at the call site (e.g. `readManifest<{ token: string }>()`).
// Default `Record<string, unknown>` matches unannotated callers.
export interface Manifest<TExtras = Record<string, unknown>> {
	packages: Package[];
	endpoints: Endpoint[];
	accounts: Account[];
	coins: Coin[];
	extras: TExtras;
}
