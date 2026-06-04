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

import type { PostgresRef } from '../../postgres/index.ts';

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

/** Local container mode — in-stack validator + faucet + GraphQL. The
 *  GraphQL indexer reads from an EXTERNAL postgres (the sui-tools base
 *  ships no embedded Postgres); supply `indexerDb` to point it at a
 *  devstack `postgres(...)` plugin. */
export interface SuiLocalOptions extends SuiCommonOptions {
	readonly mode: 'local';
	/** Image override — `{pull}` skips the build; `{build}` uses
	 *  the bundled Dockerfile + a content-hashed tag. */
	readonly image?:
		| { readonly pull: string }
		| { readonly build: { readonly context: string; readonly dockerfile?: string } };
	/** Sui binary version (default in mode/local.ts). */
	readonly version?: string;
	/** External Postgres for the embedded GraphQL indexer. REQUIRED in
	 *  local mode (GraphQL is always on; sui-tools has no embedded
	 *  Postgres). `postgres` is the resolved `postgres(...)` plugin ref;
	 *  `database` is the indexer DB name (default `'sui_indexer'`) —
	 *  declare it in `postgres({ databases: [...] })` or rely on the sui
	 *  plugin ensuring it at start. */
	readonly indexerDb?: { readonly postgres: PostgresRef; readonly database?: string };
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

/** Fork-mode faucet config. Funds test accounts by impersonating a
 *  large-reserve "whale" address on the forked upstream and transferring
 *  SUI from it — there is no real faucet on a fork. Enabled by default
 *  with a per-upstream default whale; the whale is auto-added to the
 *  fork seed and validated at boot. */
export interface SuiForkFaucetOptions {
	/** Address to impersonate as the funding source. Defaults to a known
	 *  large-reserve address for the upstream (see `FORK_DEFAULT_WHALE`).
	 *  Must hold a large single SUI coin in the fork. */
	readonly whale?: string;
	/** Upper bound on a single funding request (MIST). Guards against a
	 *  typo draining the whale. Default `1_000_000_000_000n` (1000 SUI). */
	readonly perRequestCapMist?: bigint;
	/** Disable the fork faucet entirely (default: enabled). */
	readonly enabled?: boolean;
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
	/** Pinned Git revision of the Sui repository used to build `sui-fork`. */
	readonly version?: string;
	/** Optional direct host port mapping keyed by container port. */
	readonly ports?: Readonly<Record<number, number>>;
	readonly seed?: {
		readonly addresses?: ReadonlyArray<string>;
		readonly objects?: ReadonlyArray<string>;
	};
	/** Auto-tick clock cadence (or off). */
	readonly autoTick?: boolean | { readonly intervalMs: number };
	/** Impersonation-based faucet for funding test accounts. */
	readonly faucet?: SuiForkFaucetOptions;
}

/** The discriminated union of all four mode option records. */
export type SuiOptions = SuiLocalOptions | SuiLocalRpcOptions | SuiLiveOptions | SuiForkOptions;
