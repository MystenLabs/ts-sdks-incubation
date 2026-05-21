// Walrus registry publish — narrow tag fan-out with mode-based
// asymmetric publishing.
//
// Distilled-doc invariant (06-walrus.md §"Hard requirements" item
// 14): `walrusKnownDeployment` MUST NOT publish the admin tag. Local
// cluster publishes 4-of-4 tags (network + nodes + proxy + admin);
// known publishes 3-of-4 (no admin) — and only when all three URLs
// (`proxyUrl`, `aggregatorUrl`, `publisherUrl`) are present (item 15).
//
// Architecture (composite-primitive doc §AsymmetricTagFanout): the
// mode-narrowed factory namespace handles the type-level asymmetry —
// `walrusFor(net).local` exposes `WalrusAdminTag`, `walrusFor(net).known`
// doesn't. This file is the *runtime* publishing layer for the
// downstream registries:
//
//   - WalrusStateRegistry  — `{name, systemObjectId}` entry. Local
//                            uses `opts.name`; known uses the fixed
//                            `'walrusKnownDeployment'`.
//   - EndpointRegistry     — local publishes `walrus-aggregator` +
//                            `walrus-publisher` + N × `walrus-node-<i>`.
//                            Known publishes nothing (the URLs ride
//                            on the WalrusProxyTag's resolved value).
//   - PackageRegistry      — local only: `walrus.<name>` entry.
//
// Following the package plugin's pattern, contributions land via
// `StrategyContributor` capability keys; the orchestrator dispatches
// by key. This file declares the *contribution shapes*; the actual
// `Register` closures live in `composite.ts` where the resolved
// values are bound.

/** Capability-key constant for the per-stack Walrus state registry. */
export const WALRUS_STATE_REGISTRY_KEY = 'walrus-state-registry' as const;

/** Capability-key constant for the per-stack endpoint registry —
 *  shared across plugins (matches faucet/coin/etc.). */
export const ENDPOINT_REGISTRY_KEY = 'endpoint-registry' as const;

/** Capability-key constant for the per-stack package registry —
 *  mirrors `plugins/package/registry.ts`'s
 *  `PACKAGE_REGISTRY_CAPABILITY_KEY` but typed independently here so
 *  Walrus doesn't take a direct dep on the package plugin's internals.
 *  Same string value — substrate dispatches by string equality. */
export const PACKAGE_REGISTRY_KEY = 'package-registry' as const;

/** Local-cluster's state registry entry. The `name` field is the
 *  factory's `name` option (default: `'walrus'`); two walrus
 *  instances in one stack publish under disjoint names. */
export interface WalrusLocalStateEntry {
	readonly name: string;
	readonly systemObjectId: string;
	readonly stakingObjectId: string;
	readonly walrusPackageId: string;
	readonly exchangeObjectId?: string;
}

/** Known-deployment's state registry entry. The `name` is always
 *  `'walrusKnownDeployment'` (distilled-doc invariant: this factory
 *  does not vary by user-supplied name). */
export interface WalrusKnownStateEntry {
	readonly name: 'walrusKnownDeployment';
	readonly systemObjectId: string;
	readonly stakingObjectId: string;
	readonly chain: string;
}

export type WalrusStateEntry = WalrusLocalStateEntry | WalrusKnownStateEntry;

/** Endpoint contribution shape — what the local-cluster publishes
 *  to the endpoint registry. Mirrors the v3 surface:
 *  `walrus-aggregator` + `walrus-publisher` (1 each) +
 *  `walrus-node-<i>` (N). */
export interface WalrusEndpointEntry {
	readonly name: string;
	readonly url: string;
	readonly kind: 'http' | 'walrus-node';
}

/** Package contribution — local-cluster publishes one entry under
 *  `walrus.<name>` with `mvrPlaceholder: '@local/walrus'`.
 *  (Distilled-doc §"Registry writes" + Invariant 6: registers fire
 *  on EVERY cycle.) */
export interface WalrusPackageEntry {
	readonly name: string;
	readonly packageId: string;
	readonly mvrPlaceholder: string;
	readonly captured: Readonly<{
		readonly systemObject: string;
		readonly stakingObject: string;
		readonly exchangeObject?: string;
	}>;
}
