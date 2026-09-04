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

/** Options shared by the two container-backed modes (local + fork), which
 *  both derive their validator image from `mysten/sui-tools`. */
export interface SuiContainerOptions extends SuiCommonOptions {
	/** `mysten/sui-tools` tag or commit SHA to base the validator image on
	 *  (the per-arch `-arm64` suffix is added host-side). Wins over the
	 *  `DEVSTACK_SUI_TOOLS_REF` env var. What "unset" means is per mode:
	 *  local mode falls back to devstack's bundled sui-tools pin; fork mode
	 *  compiles `sui-fork` from source instead, because the bundled pin
	 *  predates `sui-fork` shipping in sui-tools. Set it in fork mode to a
	 *  build that has it (892d777c or later) and the compile is skipped.
	 *  Also selects the CLI that stack-free `devstack codegen` runs `sui
	 *  move summary` with. Not combinable with `image.pull` (which names a
	 *  complete image) or fork `version`. */
	readonly suiToolsRef?: string;
	/** Image override — `{pull}` skips the build; `{build}` uses the
	 *  caller's Dockerfile with devstack's build args + a content-hashed
	 *  tag. */
	readonly image?:
		| { readonly pull: string }
		| { readonly build: { readonly context: string; readonly dockerfile?: string } };
}

/** Local container mode — in-stack validator + faucet + GraphQL. GraphQL,
 *  its indexer, and a Postgres are ON BY DEFAULT: the sui plugin OWNS a
 *  postgres sidecar container (labelled under sui) and auto-creates its
 *  `sui_indexer` DB, so a bare `sui()` boots the full GraphQL surface with
 *  no cross-plugin wiring. Two escape hatches: `indexer: false` opts out
 *  (RPC + faucet only, no sidecar), and `indexerDb` points GraphQL at a
 *  Postgres the caller already runs (no sidecar). */
export interface SuiLocalOptions extends SuiContainerOptions {
	readonly mode: 'local';
	/** GraphQL/indexer/Postgres on-off. Default `true` — sui owns a
	 *  postgres sidecar and runs `--with-graphql` against it. `false` ⇒
	 *  RPC + faucet only, no sidecar, no GraphQL. */
	readonly indexer?: boolean;
	/** BYO indexer Postgres (value-based escape hatch). When set, GraphQL
	 *  reads from the caller's own DB and NO sidecar is provisioned. `url`
	 *  is a PostgreSQL DSN reachable from the validator on `network`;
	 *  `database` (default `'sui_indexer'`) is appended to the DSN if it
	 *  carries no path segment. */
	readonly indexerDb?: {
		readonly url: string;
		readonly network: string;
		readonly database?: string;
	};
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
	readonly chainId?: string;
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
	readonly chainId?: string;
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
export interface SuiForkOptions extends SuiContainerOptions {
	readonly mode: 'fork';
	readonly upstream: 'mainnet' | 'testnet' | 'devnet';
	readonly checkpoint?: number;
	/** Pinned Git revision of the Sui repository used to compile `sui-fork`
	 *  from source. Only meaningful on the source-build path — set
	 *  `suiToolsRef` instead to use a prebuilt sui-tools binary. */
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
