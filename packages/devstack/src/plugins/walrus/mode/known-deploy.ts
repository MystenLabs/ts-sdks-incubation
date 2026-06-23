// Walrus mode — known deployment (testnet / mainnet / *-fork via
// upstream translation).
//
// Distilled-doc reference (06-walrus.md §"Lifecycle: Startup —
// known deployment"). Purely synchronous body — no ordered phases.
// The factory validates required deployment fields and returns a
// resolved value whose tags are eager `Layer.succeed(...)` constants.
//
// Distilled-doc invariants honored:
//   - 15: each of `proxyUrl / aggregatorUrl / publisherUrl` surfaces
//         INDEPENDENTLY. Encoded as `string | null` in the resolved
//         shape — a given field is null only when THAT specific URL
//         is unresolved (registry default + explicit override both
//         absent). The plugin's projection step publishes each tag
//         when its own URL is present; a missing publisher URL does
//         not suppress an available proxy/aggregator URL.
//   - 16: throw synchronously when `nodes` is missing for a
//         registered network. The on-chain ids
//         (`systemObjectId` / `stakingPoolId` / `exchangeIds`) ARE
//         stable and come from the `@mysten/walrus` SDK package config
//         — we default them from the SDK and let callers override.
//         Only the node committee stays explicit: testnet has 100+
//         nodes that the SDK fetches dynamically, so we don't pin them.

import { MAINNET_WALRUS_PACKAGE_CONFIG, TESTNET_WALRUS_PACKAGE_CONFIG } from '@mysten/walrus';
import { Effect, type Scope } from 'effect';

import { expectNonEmptyString } from '../../../substrate/runtime/config-validation.ts';
import { walrusConfigError, type WalrusConfigError } from '../errors.ts';
import type { WalrusStorageNode } from '../storage-nodes.ts';

/** Known networks supported by the registry lookup. */
export type WalrusKnownNetwork = 'testnet' | 'mainnet' | 'devnet';

/** Options for the known-deployment mode. */
export interface WalrusKnownDeploymentOptions {
	/** Network shortcut — looks up per-field defaults from a registry
	 *  baked into this package. */
	readonly network?: WalrusKnownNetwork;
	/** Per-field overrides for the on-chain ids. For `testnet`/`mainnet`
	 *  these default from the `@mysten/walrus` SDK package config, so
	 *  they're optional; for `devnet` (or when `network` is omitted)
	 *  `systemObjectId`/`stakingPoolId` are required. An explicit value
	 *  here always wins over the registry default. */
	readonly systemObjectId?: string;
	readonly stakingPoolId?: string;
	readonly exchangeIds?: ReadonlyArray<string>;
	/** Explicit storage-node committee. Required (throws if missing
	 *  even when `network` is set — distilled-doc invariant 16). */
	readonly nodes?: ReadonlyArray<WalrusStorageNode>;
	readonly aggregatorUrl?: string;
	readonly publisherUrl?: string;
	readonly proxyUrl?: string;
}

/** Resolved known-deployment boot artifacts. */
export interface KnownDeploymentBootResult {
	readonly mode: 'known';
	/** The known network's name (`testnet`/`mainnet`/`devnet`) — its stable
	 *  identity. A known remote deployment has no per-boot genesis digest, so
	 *  the network name IS its `chainId` for codegen/snapshot keying. */
	readonly network: string;
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
	readonly exchangeIds: ReadonlyArray<string>;
	readonly nodes: ReadonlyArray<WalrusStorageNode>;
	/** Null only when the proxy URL itself is unresolved (no explicit
	 *  `proxyUrl` override and no registry/aggregator/publisher
	 *  fallback). Surfaces independently of `aggregatorUrl` /
	 *  `publisherUrl` — distilled-doc invariant 15. */
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
}

/** Known-deployment registry — baked-in record per network. The
 *  on-chain ids default from the `@mysten/walrus` SDK package config
 *  (`{TESTNET,MAINNET}_WALRUS_PACKAGE_CONFIG`) so a caller only needs
 *  to supply `nodes`; the aggregator/publisher/proxy URLs are
 *  devstack-owned (the SDK ships none). Devnet has no canonical SDK
 *  record today, so it keeps no id defaults. */
const KNOWN_DEPLOYMENT_REGISTRY: Readonly<
	Record<
		WalrusKnownNetwork,
		{
			readonly network: string;
			readonly systemObjectId?: string;
			readonly stakingPoolId?: string;
			readonly exchangeIds?: ReadonlyArray<string>;
			readonly aggregatorUrl?: string;
			readonly publisherUrl?: string;
			readonly proxyUrl?: string;
		}
	>
> = {
	testnet: {
		network: 'testnet',
		// On-chain ids default from the SDK package config; callers may
		// still override per-field. The URLs below are devstack-owned —
		// the SDK ships none.
		systemObjectId: TESTNET_WALRUS_PACKAGE_CONFIG.systemObjectId,
		stakingPoolId: TESTNET_WALRUS_PACKAGE_CONFIG.stakingPoolId,
		exchangeIds: TESTNET_WALRUS_PACKAGE_CONFIG.exchangeIds,
		aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
		publisherUrl: 'https://publisher.walrus-testnet.walrus.space',
		proxyUrl: 'https://aggregator.walrus-testnet.walrus.space',
	},
	mainnet: {
		network: 'mainnet',
		// On-chain ids default from the SDK package config; callers may
		// still override per-field. Mainnet ships no `exchangeIds` in the
		// SDK config (testnet-only faucet exchange), so it stays absent.
		systemObjectId: MAINNET_WALRUS_PACKAGE_CONFIG.systemObjectId,
		stakingPoolId: MAINNET_WALRUS_PACKAGE_CONFIG.stakingPoolId,
		aggregatorUrl: 'https://aggregator.walrus.space',
		publisherUrl: 'https://publisher.walrus.space',
		proxyUrl: 'https://aggregator.walrus.space',
	},
	devnet: {
		network: 'devnet',
	},
};

/** Synchronous factory-time validation + projection. Throws (NOT
 *  Effect-fail) on missing required fields so misconfiguration trips
 *  at the `defineDevstack` call site rather than at deferred
 *  Layer.build time. Distilled-doc invariants 14 + 16. */
export const resolveKnownDeploymentOptions = (
	opts: WalrusKnownDeploymentOptions,
): KnownDeploymentBootResult => {
	const reg = opts.network ? KNOWN_DEPLOYMENT_REGISTRY[opts.network] : undefined;

	// On-chain ids: caller override (`opts.*`) wins, else the registry
	// default sourced from the `@mysten/walrus` SDK package config.
	// Testnet/mainnet default from the SDK so only `nodes` is required;
	// devnet has no SDK record, so these stay required there.
	const systemObjectId = expectNonEmptyString(opts.systemObjectId ?? reg?.systemObjectId, {
		field: 'systemObjectId',
		mkError: ({ field }) =>
			walrusConfigError(
				field,
				`walrusKnownDeployment: 'systemObjectId' is required (testnet/mainnet default from the @mysten/walrus SDK; pass it explicitly for devnet or networks without an SDK record)`,
			),
	});

	const stakingPoolId = expectNonEmptyString(opts.stakingPoolId ?? reg?.stakingPoolId, {
		field: 'stakingPoolId',
		mkError: ({ field }) =>
			walrusConfigError(
				field,
				`walrusKnownDeployment: 'stakingPoolId' is required (testnet/mainnet default from the @mysten/walrus SDK; pass it explicitly for devnet or networks without an SDK record)`,
			),
	});

	const nodes = opts.nodes;
	if (!nodes) {
		// Distilled-doc invariant 16: even when `network` is set, the
		// node committee must be explicit. The on-chain ids come from
		// the SDK package config, but the committee is dynamic — testnet
		// has 100+ nodes the SDK fetches at runtime, so we don't pin it.
		throw walrusConfigError(
			'nodes',
			`walrusKnownDeployment: explicit 'nodes' committee is required — ` +
				`Walrus ${opts.network ?? 'custom'} has nodes fetched dynamically by the SDK`,
			`pass an empty array if you accept the SDK-driven committee lookup, ` +
				`or use walrus()/walrusFor(network).local({...}) for a local self-hosted cluster`,
		);
	}

	const aggregatorUrl = opts.aggregatorUrl ?? reg?.aggregatorUrl ?? null;
	const publisherUrl = opts.publisherUrl ?? reg?.publisherUrl ?? null;
	const proxyUrl = opts.proxyUrl ?? reg?.proxyUrl ?? aggregatorUrl ?? publisherUrl ?? null;

	// Invariant 15: surface null per individual URL when missing so the
	// plugin's projection can conditionally publish each tag. Previously
	// any single missing URL nullified all three, dropping user-supplied
	// values for the URLs they did provide.
	return {
		mode: 'known' as const,
		network: reg?.network ?? 'custom',
		systemObjectId,
		stakingPoolId,
		exchangeIds: opts.exchangeIds ?? reg?.exchangeIds ?? [],
		nodes,
		proxyUrl,
		aggregatorUrl,
		publisherUrl,
	};
};

/** "Boot" the known deployment. Purely synchronous projection inside
 *  Effect.gen — no I/O, no Scope work. Surfaces as Effect for
 *  uniformity with the local-cluster boot signature. */
export const bootKnownDeployment = (
	opts: WalrusKnownDeploymentOptions,
): Effect.Effect<KnownDeploymentBootResult, WalrusConfigError, Scope.Scope> =>
	Effect.try({
		try: () => resolveKnownDeploymentOptions(opts),
		// `resolveKnownDeploymentOptions` throws our typed config error
		// shape. STYLE_GUIDE §2 forbids bare error casts; runtime-guard
		// the `_tag` so an unexpected synchronous throw (e.g. a future
		// helper that throws a stock `TypeError`) is wrapped instead of
		// silently mis-tagged as `WalrusConfigError`.
		catch: (err): WalrusConfigError => {
			if (
				typeof err === 'object' &&
				err !== null &&
				'_tag' in err &&
				(err as { readonly _tag?: unknown })._tag === 'WalrusConfigError'
			) {
				return err as WalrusConfigError;
			}
			return walrusConfigError(
				'unknown',
				`walrusKnownDeployment: unexpected non-typed throw inside resolveKnownDeploymentOptions: ${
					err instanceof Error ? err.message : String(err)
				}`,
				undefined,
				err,
			);
		},
	});
