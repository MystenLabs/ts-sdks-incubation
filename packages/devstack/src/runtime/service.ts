// `Devstack` — the canonical runtime accessor for app code.
//
// `yield* Devstack` in any Effect program (after `devstack(...).layer`
// is provided) returns a typed accessor for the running stack:
// services, packages, accounts, coins, and app endpoints, all keyed by
// the names declared in the user's config. The shape mirrors `Manifest`
// (the on-disk schema) field-for-field so app code can move between
// "served from a live Effect" and "read from manifest.json" by swapping
// `yield* (yield* Devstack).current()` for `fromManifest(...)` with no
// other changes.
//
// Implementation reads `PackageRegistry`, `EndpointRegistry`,
// `AccountRegistry`, `CoinRegistry` plus the `Identity` service for
// stack/network/app fields. The internal `gatherManifest` helper is
// exported so the manifest emitter (`runtime/manifest-emit.ts`) can
// reuse the same gather logic without duplicating the structured-
// conversion step.

import { Context, Effect, Layer } from 'effect';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	CoinRegistry,
	EndpointRegistry,
	PackageRegistry,
} from '../engine/registries.js';
import { EndpointName } from './endpoint-names.js';
import { toSdkCoin } from './sdk-coin.js';
import type {
	AppManifest,
	EndpointEntry,
	Manifest,
	SealManifest,
	SuiManifest,
	WalrusManifest,
} from './manifest-schema.js';

// -----------------------------------------------------------------------------
// Endpoint name conventions — flat registry → structured manifest
// -----------------------------------------------------------------------------
// Factories publish endpoint records into the flat `EndpointRegistry`
// (`{name: EndpointName.SUI_RPC, url: ...}`). The converters below map
// the well-known names into the structured `services` fields of the
// manifest. Names not in this map are silently dropped from the
// structured shape — add them here (and to `endpoint-names.ts`) when a
// new built-in factory wants its endpoint to surface under `services.*`
// rather than appearing only in the flat list.

const SUI_FIELDS: Record<string, keyof Omit<SuiManifest, 'network' | 'chainId'>> = {
	[EndpointName.SUI_RPC]: 'rpc',
	[EndpointName.SUI_FAUCET]: 'faucet',
	[EndpointName.SUI_GRAPHQL]: 'graphql',
	[EndpointName.SUI_INDEXER_DB]: 'indexerDb',
};

interface FlatEndpoint {
	readonly name: string;
	readonly url: string;
	readonly kind?: string;
	readonly pairUrl?: string;
}

const toEndpointEntry = (e: FlatEndpoint): EndpointEntry =>
	e.pairUrl !== undefined ? { url: e.url, pairUrl: e.pairUrl } : { url: e.url };

const groupSui = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	network: string,
): SuiManifest | undefined => {
	const rpc = endpoints.find((e) => e.name === EndpointName.SUI_RPC);
	if (rpc === undefined) return undefined;
	let out: SuiManifest = { network, rpc: toEndpointEntry(rpc) };
	for (const e of endpoints) {
		const field = SUI_FIELDS[e.name];
		if (field !== undefined && field !== 'rpc') {
			out = { ...out, [field]: toEndpointEntry(e) };
		}
	}
	return out;
};

const groupSeal = (endpoints: ReadonlyArray<FlatEndpoint>): SealManifest | undefined => {
	const ks = endpoints.find((e) => e.name === EndpointName.SEAL_KEY_SERVER);
	return ks !== undefined ? { keyServer: toEndpointEntry(ks) } : undefined;
};

const groupWalrus = (endpoints: ReadonlyArray<FlatEndpoint>): WalrusManifest | undefined => {
	const agg = endpoints.find((e) => e.name === EndpointName.WALRUS_AGGREGATOR);
	const pub = endpoints.find((e) => e.name === EndpointName.WALRUS_PUBLISHER);
	if (agg === undefined || pub === undefined) return undefined;
	return { aggregator: toEndpointEntry(agg), publisher: toEndpointEntry(pub) };
};

const groupApp = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	extras: Record<string, unknown>,
): AppManifest => {
	const dev =
		endpoints.find((e) => e.name === EndpointName.DEV_SERVER_PRIMARY) ??
		endpoints.find((e) => e.name === EndpointName.DEV_SERVER_FALLBACK);
	const wallet = endpoints.find((e) => e.name === EndpointName.WALLET_APP);
	return {
		extras,
		...(dev !== undefined ? { dev: toEndpointEntry(dev) } : {}),
		...(wallet !== undefined ? { wallet: toEndpointEntry(wallet) } : {}),
	};
};

// -----------------------------------------------------------------------------
// gatherManifest — read registries + Identity, return v4 Manifest shape
// -----------------------------------------------------------------------------

/** Read every devstack registry and build the `Manifest` shape. Pure
 *  Effect computation against the canonical registries — no IO. Used by
 *  both `Devstack` (live snapshot) and `runtime/manifest-emit.ts` (disk
 *  write).
 *
 *  `extras` is the user-supplied extras blob resolved from the
 *  `ExtrasResolved` service; this function gathers from the registries
 *  only. Callers needing extras pass them in directly. */
export const gatherManifest = (
	extras: Record<string, unknown> = {},
): Effect.Effect<
	Manifest,
	never,
	PackageRegistry | EndpointRegistry | AccountRegistry | CoinRegistry | Identity
> =>
	Effect.gen(function* () {
		const identity = yield* Identity;
		const pkgs = yield* PackageRegistry;
		const eps = yield* EndpointRegistry;
		const accts = yield* AccountRegistry;
		const coinsReg = yield* CoinRegistry;

		// Dedupe by name (last-wins). HMR-style re-runs re-register the
		// same name, so the last write per name should win.
		const rawPkgs = yield* pkgs.snapshot;
		const rawEps = yield* eps.snapshot;
		const rawAccts = yield* accts.snapshot;
		const rawCoins = yield* coinsReg.snapshot;

		const dedupedPkgs = new Map(rawPkgs.map((p) => [p.name, p]));
		const dedupedEps = new Map(rawEps.map((e) => [e.name, e]));
		const dedupedAccts = new Map(rawAccts.map((a) => [a.name, a]));
		const dedupedCoins = new Map(rawCoins.map((c) => [c.name, c]));

		const endpoints = [...dedupedEps.values()];

		const sui = groupSui(endpoints, identity.network);
		const seal = groupSeal(endpoints);
		const walrus = groupWalrus(endpoints);
		// deepbook is populated by the deepbook factory directly via its
		// own manifest contribution, not from the flat endpoint registry,
		// so it's intentionally absent here.
		const services: Manifest['services'] = {
			...(sui !== undefined ? { sui } : {}),
			...(seal !== undefined ? { seal } : {}),
			...(walrus !== undefined ? { walrus } : {}),
		};

		const packages: Record<string, Manifest['packages'][string]> = {};
		for (const p of dedupedPkgs.values()) {
			packages[p.name] = {
				id: p.packageId,
				captured: p.captured ?? {},
				...(p.upgradeCapId !== undefined ? { upgradeCapId: p.upgradeCapId } : {}),
				...(p.mvrPlaceholder !== undefined ? { mvr: p.mvrPlaceholder } : {}),
			};
		}

		const accounts: Record<string, Manifest['accounts'][string]> = {};
		for (const a of dedupedAccts.values()) {
			accounts[a.name] = { address: a.address };
		}

		const coins: Record<string, Manifest['coins'][string]> = {};
		for (const c of dedupedCoins.values()) {
			coins[c.name] = {
				type: c.type,
				decimals: c.decimals,
				sdkCoin: c.sdkCoin ?? toSdkCoin({ fullCoinType: c.type, decimals: c.decimals }),
			};
		}

		const app = groupApp(endpoints, extras);

		return {
			version: 4 as const,
			stack: { name: identity.stack, network: identity.network, app: identity.app },
			services,
			packages,
			accounts,
			coins,
			app,
		};
	});

// -----------------------------------------------------------------------------
// Devstack Effect Service
// -----------------------------------------------------------------------------

/** The canonical runtime accessor. `yield* Devstack` returns a thunk
 *  that re-snapshots the registries on demand — late-registered
 *  services (e.g. a wallet endpoint that boots AFTER an Action's body
 *  has already yielded `Devstack`) become visible by calling
 *  `current()`. The layer build is non-eager: we don't capture a
 *  snapshot at acquire-time, so registries seeded after the layer
 *  builds are reflected on every subsequent `current()` call.
 *
 *  ```ts
 *  const dev = yield* Devstack;
 *  const manifest = yield* dev.current();
 *  ``` */
export interface DevstackShape {
	/** Re-gather the manifest from the live registries. Use whenever a
	 *  fresh manifest snapshot is needed; cheap (pure registry read). */
	readonly current: () => Effect.Effect<
		Manifest,
		never,
		PackageRegistry | EndpointRegistry | AccountRegistry | CoinRegistry | Identity
	>;
}

export class Devstack extends Context.Service<Devstack, DevstackShape>()('@devstack/Devstack') {}

/** Live layer for `Devstack`. Non-eager: `current()` calls
 *  `gatherManifest` on each invocation so registries seeded AFTER the
 *  layer builds are reflected. */
export const DevstackLive: Layer.Layer<Devstack, never, never> = Layer.succeed(Devstack, {
	current: () => gatherManifest(),
});
