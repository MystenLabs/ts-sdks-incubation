// `Devstack` — the canonical runtime accessor for app code.
//
// `yield* Devstack` in any Effect program (after `devstack(...).layer`
// is provided) returns a typed snapshot of the running stack: services,
// packages, accounts, coins, and app endpoints, all keyed by the names
// declared in the user's config. The shape mirrors `Manifest` (the
// on-disk schema) field-for-field so app code can move between
// "served from a live Effect" and "read from manifest.json" by swapping
// `yield* Devstack` for `fromManifest(...)` with no other changes.
//
// Implementation reads the same registries that `manifest()` reads
// (`PackageRegistry`, `EndpointRegistry`, `AccountRegistry`,
// `CoinRegistry`) plus the `Identity` service for stack/network/app
// fields. The internal `gatherManifest` helper is exported so the v4
// manifest emitter can reuse the same gather logic without duplicating
// the structured-conversion step.

import { Context, Effect, Layer } from 'effect';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	CoinRegistry,
	EndpointRegistry,
	PackageRegistry,
} from '../engine/registries.js';
import { toSdkCoin } from '../services/package.js';
import type {
	AppManifest,
	EndpointEntry,
	Manifest,
	SealManifest,
	SuiManifest,
	WalrusManifest,
} from './manifest-schema.js';

// -----------------------------------------------------------------------------
// Endpoint name conventions — v3 registry → v4 structured manifest
// -----------------------------------------------------------------------------
// During Phase 1+2 we still gather from the legacy flat `EndpointRegistry`
// (records like `{name: 'sui-rpc', url: ...}`). Phase-2 factories may
// emit richer records directly; until they do, the converter below maps
// well-known v3 names into v4's structured fields. Names not in this
// map are silently dropped from the structured shape — Phase 6 deletes
// the converter once every factory has migrated to structured emission.

const SUI_FIELDS: Record<string, keyof Omit<SuiManifest, 'network' | 'chainId'>> = {
	'sui-rpc': 'rpc',
	'sui-faucet': 'faucet',
	'sui-graphql': 'graphql',
	'sui-indexer-db': 'indexerDb',
};

interface FlatEndpoint {
	readonly name: string;
	readonly url: string;
	readonly kind?: string;
	readonly pairUrl?: string;
}

const toEndpointEntry = (e: FlatEndpoint): EndpointEntry =>
	e.pairUrl !== undefined ? { url: e.url, alternates: [e.pairUrl] } : { url: e.url };

const groupSui = (endpoints: ReadonlyArray<FlatEndpoint>, network: string): SuiManifest | undefined => {
	const rpc = endpoints.find((e) => e.name === 'sui-rpc');
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
	const ks = endpoints.find((e) => e.name === 'seal-key-server');
	return ks !== undefined ? { keyServer: toEndpointEntry(ks) } : undefined;
};

const groupWalrus = (endpoints: ReadonlyArray<FlatEndpoint>): WalrusManifest | undefined => {
	const agg = endpoints.find((e) => e.name === 'walrus-aggregator');
	const pub = endpoints.find((e) => e.name === 'walrus-publisher');
	if (agg === undefined || pub === undefined) return undefined;
	return { aggregator: toEndpointEntry(agg), publisher: toEndpointEntry(pub) };
};

const groupApp = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	extras: Record<string, unknown>,
): AppManifest => {
	const dev =
		endpoints.find((e) => e.name === 'frontend.dev-server') ??
		endpoints.find((e) => e.name === 'dev-server');
	const wallet = endpoints.find((e) => e.name === 'wallet-app');
	return {
		extras,
		...(dev !== undefined ? { dev: toEndpointEntry(dev) } : {}),
		...(wallet !== undefined ? { wallet: toEndpointEntry(wallet) } : {}),
	};
};

// -----------------------------------------------------------------------------
// gatherManifest — read registries + Identity, return v4 Manifest shape
// -----------------------------------------------------------------------------

/** Read every devstack registry and build the v4 `Manifest` shape. Pure
 *  Effect computation against the canonical registries — no IO. Used by
 *  both `Devstack` (live snapshot) and `runtime/manifest-emit.ts` (disk
 *  write).
 *
 *  `extras` is the user-supplied extras blob from the (future) `manifest`
 *  factory; this gathers from the registries only. Callers needing
 *  extras pass them in directly. */
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

		// Dedupe by name (last-wins). v3 emits the same dedupe behaviour
		// because HMR-style re-runs re-register the same name.
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
		// deepbook is populated by the (future) v4 deepbook factory directly,
		// not from the flat endpoint registry; left absent here.
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

/** The canonical runtime accessor. `yield* Devstack` returns the live
 *  v4 manifest snapshot built from the same registries `manifest()` reads.
 *
 *  Static — captured once at scope-acquire. For live-updating consumers
 *  (the rare watcher case), yield individual per-Ref tags from
 *  `advanced.*` instead. */
export class Devstack extends Context.Service<Devstack, Manifest>()('@devstack/Devstack') {}

/** Live layer for `Devstack`. Builds from the registries at scope-
 *  acquire and exposes the snapshot to downstream `yield* Devstack`. */
export const DevstackLive: Layer.Layer<
	Devstack,
	never,
	PackageRegistry | EndpointRegistry | AccountRegistry | CoinRegistry | Identity
> = Layer.effect(Devstack, gatherManifest());
