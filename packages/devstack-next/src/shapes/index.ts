// Shared shape types for cross-plugin fan-in. Plugins that publish their
// state into one of these categories should `represents:` it under the
// corresponding key (`packages`, `endpoints`, `accounts`) AND expose a
// typed Dep that returns the shape verbatim, so `codegen` and friends can
// consume them without a string-keyed registry.
//
// Plugins are free to define their own shape types beyond these — the
// engine doesn't care. These are the conventional defaults that the core
// codegen / TUI / observability tools pivot on.

export interface Package {
	/** Logical name (`'token'`, `'nft'`). Used as the codegen subdir. */
	name: string;
	/** On-chain object id of the published package. */
	packageId: string;
	/** MVR placeholder string (`@local/<app>::<pkg>`). Optional — codegen
	 * fills it in if the consumer needs it. */
	mvrPlaceholder?: string;
}

export interface Endpoint {
	/** Stable display name (`'sui-rpc'`, `'walrus-aggregator'`). */
	name: string;
	/** Full URL incl. scheme + host + port. */
	url: string;
	/** Optional category for grouping in the TUI / dashboard. */
	kind?: string;
}

export interface Account {
	/** Logical name (`'publisher'`, `'minter'`). */
	name: string;
	/** Sui address (0x-prefixed hex). */
	address: string;
}
