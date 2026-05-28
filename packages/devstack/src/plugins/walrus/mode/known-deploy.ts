// Walrus mode — known deployment (testnet / mainnet / *-fork via
// upstream translation).
//
// Distilled-doc reference (06-walrus.md §"Lifecycle: Startup —
// known deployment"). Purely synchronous body — no ordered phases.
// The factory validates required deployment fields and returns a
// resolved value whose tags are eager `Layer.succeed(...)` constants.
//
// Distilled-doc invariants honored:
//   - 15: `WalrusProxyTag` only when ALL three URLs (proxy,
//         aggregator, publisher) are present. Encoded as
//         `proxyUrl / aggregatorUrl / publisherUrl: string | null`
//         in the resolved shape; the plugin's projection step
//         hides the proxy tag when any is missing.
//   - 16: throw synchronously when `nodes` is missing for a
//         registered network. Testnet has 100+ nodes that the
//         `@mysten/walrus` SDK fetches dynamically; pinning them
//         statically would be misleading.

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
	/** Per-field overrides. Required when `network` is omitted. */
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
	readonly chain: string;
	readonly systemObjectId: string;
	readonly stakingPoolId: string;
	readonly exchangeIds: ReadonlyArray<string>;
	readonly nodes: ReadonlyArray<WalrusStorageNode>;
	/** Null when any of the three URLs are missing — distilled-doc
	 *  invariant 15. */
	readonly proxyUrl: string | null;
	readonly aggregatorUrl: string | null;
	readonly publisherUrl: string | null;
}

/** Known-deployment registry — baked-in record per network. The
 *  values here mirror v3's `knownDeployments.walrus.{testnet,
 *  mainnet}` entries. Devnet has no canonical record today. */
const KNOWN_DEPLOYMENT_REGISTRY: Readonly<
	Record<
		WalrusKnownNetwork,
		{
			readonly chain: string;
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
		chain: 'sui:testnet',
		// Real ids must be supplied via the explicit options form
		// (`walrusFor(testnet).known({ systemObjectId, stakingPoolId, ... })`).
		// The known-deployment lookup table only canonicalises the URLs;
		// the on-chain ids are network-specific and live outside this
		// package.
		systemObjectId: undefined,
		stakingPoolId: undefined,
		exchangeIds: [],
		aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
		publisherUrl: 'https://publisher.walrus-testnet.walrus.space',
		proxyUrl: 'https://aggregator.walrus-testnet.walrus.space',
	},
	mainnet: {
		chain: 'sui:mainnet',
		systemObjectId: undefined,
		stakingPoolId: undefined,
		exchangeIds: [],
		aggregatorUrl: 'https://aggregator.walrus.space',
		publisherUrl: 'https://publisher.walrus.space',
		proxyUrl: 'https://aggregator.walrus.space',
	},
	devnet: {
		chain: 'sui:devnet',
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

	const systemObjectId = expectNonEmptyString(opts.systemObjectId ?? reg?.systemObjectId, {
		field: 'systemObjectId',
		mkError: ({ field }) =>
			walrusConfigError(
				field,
				`walrusKnownDeployment: 'systemObjectId' is required (pass it explicitly, or pass network with a registered entry)`,
			),
	});

	const stakingPoolId = expectNonEmptyString(opts.stakingPoolId ?? reg?.stakingPoolId, {
		field: 'stakingPoolId',
		mkError: ({ field }) =>
			walrusConfigError(
				field,
				`walrusKnownDeployment: 'stakingPoolId' is required (pass it explicitly, or pass network with a registered entry)`,
			),
	});

	const nodes = opts.nodes;
	if (!nodes) {
		// Distilled-doc invariant 16: even when `network` is set, the
		// nodes must be explicit. Testnet has 100+ nodes the SDK
		// fetches dynamically; pinning would be misleading.
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
		chain: reg?.chain ?? 'sui:custom',
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
		// shape; map straight back into the typed channel.
		catch: (err) => err as WalrusConfigError,
	});
