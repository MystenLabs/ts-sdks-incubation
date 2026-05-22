// Sui plugin — internal mode discriminator + spec shapes.
//
// Architecture: the four modes are NOT four separate plugins. They
// are one plugin with internal mode dispatch, exposed at the
// authoring surface via a single `sui()` local shorthand or
// `suiFor(network)` (typed mode narrowing).
//
// The factory namespace shape (architecture Tension 11) is realised
// via `defineModeNamespace({ local, live, fork })` in the barrel —
// see `../index.ts` for the user-facing factory.

import type { Duration } from 'effect';

/** Internal mode discriminator. Distinct from the substrate's
 *  `NetworkMode` because we surface a degenerate `local-rpc`
 *  sub-mode (caller-supplied RPC URL — no container needed) under
 *  the substrate-level `'local'` branch. */
export type SuiPluginMode = 'local' | 'local-rpc' | 'live' | 'fork';

/** Common Sui plugin options. Mode-specific identity pins live on the
 *  modes that actually accept caller-supplied endpoints. */
export interface SuiCommonOptions {
	/** Ready-probe timeout. Per-mode defaults are mode-specific. */
	readonly readyTimeout?: Duration.Duration;
}

/** Local container mode — in-stack validator + faucet + GraphQL +
 *  postgres indexer. */
export interface SuiLocalOptions extends SuiCommonOptions {
	readonly mode: 'local';
	/** Image override — `{pull}` skips the build; `{build}` uses
	 *  the bundled Dockerfile + a content-hashed tag. */
	readonly image?:
		| { readonly pull: string }
		| { readonly build: { readonly context: string; readonly dockerfile?: string } };
	/** Sui binary version (default in mode/local.ts). */
	readonly version?: string;
	/** Optional direct host port mapping keyed by container port. When
	 *  supplied, the mapping is exact: Sui does not reassign missing
	 *  or busy host ports through the PortBroker. Omit this field to
	 *  use brokered private host-port defaults for RPC/faucet/GraphQL
	 *  and reassign on collision. Router entrypoints own the public
	 *  9000/9123/9125 ports. */
	readonly ports?: Readonly<Record<number, number>>;
}

/** Local RPC mode — caller already has a Sui process; we
 *  wrap it. NO container, NO postgres sidecar, NO build image. */
export interface SuiLocalRpcOptions extends SuiCommonOptions {
	readonly mode: 'local-rpc';
	readonly rpcUrl: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
	/** Optional chain id pin for caller-owned endpoints. Omit to
	 *  probe the RPC endpoint. */
	readonly chain?: string;
}

/** Live testnet / mainnet / custom-RPC mode. */
export interface SuiLiveOptions extends SuiCommonOptions {
	readonly mode: 'live';
	/** Discriminator for known-network defaulting; `custom` requires
	 *  rpcUrl. */
	readonly network: 'testnet' | 'mainnet' | 'devnet' | 'custom';
	readonly rpcUrl?: string;
	readonly faucetUrl?: string;
	readonly graphqlUrl?: string;
	/** Optional chain id pin for custom/caller-owned live endpoints.
	 *  Omit to probe the RPC endpoint. */
	readonly chain?: string;
}

/** Fork mode — sui-fork binary mirroring a real chain at a
 *  checkpoint. */
export interface SuiForkOptions extends SuiCommonOptions {
	readonly mode: 'fork';
	readonly upstream: 'mainnet' | 'testnet' | 'devnet';
	readonly checkpoint?: number;
	readonly image?:
		| { readonly pull: string }
		| { readonly build: { readonly context: string; readonly dockerfile?: string } };
	/** Pinned commit SHA of `sui-fork`. */
	readonly version?: string;
	readonly seed?: {
		readonly addresses?: ReadonlyArray<string>;
		readonly objects?: ReadonlyArray<string>;
	};
	readonly defaultGasBudget?: bigint;
	/** Auto-tick clock cadence (or off). */
	readonly autoTick?: boolean | { readonly intervalMs: number };
}

/** The discriminated union of all four mode option records. */
export type SuiOptions = SuiLocalOptions | SuiLocalRpcOptions | SuiLiveOptions | SuiForkOptions;
