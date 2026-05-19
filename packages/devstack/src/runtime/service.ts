// `gatherManifest` — read every devstack registry + Identity and build
// the `Manifest` shape used by the on-disk `.devstack/manifest.json`,
// the codegen emitters, and any Effect-native consumer that wants a
// live snapshot.
//
// Per-service projections are declared via `defineServiceProjection`
// (engine/service-projection.ts). Adding a new service is one entry in
// the table below — the last-record-from-snapshot + dedupe-by-name
// boilerplate lives in the helper, not in this file.

import { Effect } from 'effect';
import { findEndpointDeclaration } from '../engine/define-endpoint.js';
import { Identity } from '../engine/identity.js';
import {
	AccountRegistry,
	CoinRegistry,
	DeepbookIndexerStateRegistry,
	DeepbookMarginStateRegistry,
	DeepbookServerStateRegistry,
	DeepbookStateRegistry,
	EndpointRegistry,
	PackageRegistry,
	PostgresStateRegistry,
	PythStateRegistry,
	SealStateRegistry,
	SuiStateRegistry,
	WalrusStateRegistry,
	type DeepbookIndexerStateRecord,
	type DeepbookMarginStateRecord,
	type DeepbookServerStateRecord,
	type DeepbookStateRecord,
} from '../engine/registries.js';
import { defineServiceProjection } from '../engine/service-projection.js';
import { EndpointName } from './endpoint-names.js';
import { toSdkCoin } from './sdk-coin.js';
import type {
	AppManifest,
	DeepbookIndexerManifest,
	DeepbookManifest,
	DeepbookMarginManifest,
	DeepbookServerManifest,
	EndpointEntry,
	Manifest,
	PostgresManifest,
	PythManifest,
	SealManifest,
	SuiManifest,
	WalrusManifest,
} from './manifest-schema.js';

// Derive the manifest-leaf field name an endpoint projects into, given
// a `services.X.<leaf>` prefix. Reads the endpoint's `defineEndpoint(...)`
// declaration via the lookup registry — adding a new endpoint with
// `manifestField: { path: '...' }` is automatically picked up.
const manifestLeafUnder = (endpointName: string, prefix: string): string | undefined => {
	const decl = findEndpointDeclaration(endpointName);
	if (decl?.manifestField === undefined) return undefined;
	const path = decl.manifestField.path;
	const head = `${prefix}.`;
	return path.startsWith(head) ? path.slice(head.length) : undefined;
};

interface FlatEndpoint {
	readonly name: string;
	readonly url: string;
	readonly kind?: string;
	readonly pairUrl?: string;
}

const toEndpointEntry = (e: FlatEndpoint): EndpointEntry =>
	e.pairUrl !== undefined ? { url: e.url, pairUrl: e.pairUrl } : { url: e.url };

// Cross-cutting inputs every projection reads. Tag-typed registry state
// is threaded by the helper itself; only inputs shared across
// projections live here.
interface ProjectionContext {
	readonly endpoints: ReadonlyArray<FlatEndpoint>;
	readonly network: string;
}

// -----------------------------------------------------------------------------
// Service projections — one declarative entry per `services.*` view.
// -----------------------------------------------------------------------------

const suiProjection = defineServiceProjection<ProjectionContext>()({
	name: 'sui',
	registry: SuiStateRegistry,
	project: ({ state, ctx }): SuiManifest | undefined => {
		const rpc = ctx.endpoints.find((e) => e.name === EndpointName.SUI_RPC);
		if (rpc === undefined) return undefined;
		let out: SuiManifest = { network: ctx.network, rpc: toEndpointEntry(rpc) };
		if (state !== undefined) out = { ...out, chainId: state.chainId };
		for (const e of ctx.endpoints) {
			const field = manifestLeafUnder(e.name, 'services.sui');
			if (field !== undefined && field !== 'rpc' && field !== 'network' && field !== 'chainId') {
				out = { ...out, [field as keyof SuiManifest]: toEndpointEntry(e) };
			}
		}
		return out;
	},
});

const sealProjection = defineServiceProjection<ProjectionContext>()({
	name: 'seal',
	registry: SealStateRegistry,
	project: ({ state, ctx }): SealManifest | undefined => {
		const ks = ctx.endpoints.find((e) => e.name === EndpointName.SEAL_KEY_SERVER);
		if (ks === undefined) return undefined;
		return state !== undefined
			? { keyServer: toEndpointEntry(ks), objectId: state.objectId }
			: { keyServer: toEndpointEntry(ks) };
	},
});

const walrusProjection = defineServiceProjection<ProjectionContext>()({
	name: 'walrus',
	registry: WalrusStateRegistry,
	project: ({ state, ctx }): WalrusManifest | undefined => {
		const agg = ctx.endpoints.find((e) => e.name === EndpointName.WALRUS_AGGREGATOR);
		const pub = ctx.endpoints.find((e) => e.name === EndpointName.WALRUS_PUBLISHER);
		if (agg === undefined || pub === undefined) return undefined;
		const base: WalrusManifest = {
			aggregator: toEndpointEntry(agg),
			publisher: toEndpointEntry(pub),
		};
		return state !== undefined ? { ...base, systemObjectId: state.systemObjectId } : base;
	},
});

const pythProjection = defineServiceProjection<ProjectionContext>()({
	name: 'pyth',
	registry: PythStateRegistry,
	project: ({ state }): PythManifest | undefined => {
		if (state === undefined) return undefined;
		return {
			packageId: state.packageId,
			...(state.pythStateId !== undefined ? { pythStateId: state.pythStateId } : {}),
			...(state.wormholeStateId !== undefined ? { wormholeStateId: state.wormholeStateId } : {}),
			priceInfoObjectIds: state.priceInfoObjectIds,
			feeds: state.feeds,
		};
	},
});

const postgresProjection = defineServiceProjection<ProjectionContext>()({
	name: 'postgres',
	registry: PostgresStateRegistry,
	project: ({ state }): PostgresManifest | undefined => {
		if (state === undefined) return undefined;
		// `state.endpoint` is guaranteed plain (no credentials) by the
		// registry-shape contract; password lives in `state.password` and
		// is never copied here. Surfacing the password is impossible by
		// construction, not by a per-call strip step.
		return {
			user: state.user,
			endpoint: { url: state.endpoint },
			containerNetwork: state.containerNetwork,
			networkAlias: state.networkAlias,
			databases: state.databases,
		};
	},
});

// Deepbook reads four state registries (state, indexer, server, margin)
// so it doesn't fit the single-registry `defineServiceProjection` shape.
// It stays as a free function until a multi-registry projection variant
// lands (or the integration-contract redesign collapses deepbook's four
// registries into one).
const groupDeepbook = (
	state: DeepbookStateRecord | undefined,
	indexer: DeepbookIndexerStateRecord | undefined,
	server: DeepbookServerStateRecord | undefined,
	margin: DeepbookMarginStateRecord | undefined,
): DeepbookManifest | undefined => {
	if (state === undefined) return undefined;
	const indexerManifest: DeepbookIndexerManifest | undefined =
		indexer !== undefined ? { metrics: { url: indexer.metricsUrl } } : undefined;
	const serverManifest: DeepbookServerManifest | undefined =
		server !== undefined
			? { rest: { url: server.restUrl }, metrics: { url: server.metricsUrl } }
			: undefined;
	const marginManifest: DeepbookMarginManifest | undefined =
		margin !== undefined
			? {
					packageId: margin.packageId,
					liquidationPackageId: margin.liquidationPackageId,
					registryId: margin.registryId,
					adminCapId: margin.adminCapId,
					...(margin.maintainerCapId !== undefined
						? { maintainerCapId: margin.maintainerCapId }
						: {}),
					marginPools: margin.marginPools,
					registeredPools: margin.registeredPools,
				}
			: undefined;
	return {
		packageId: state.packageId,
		pools: state.pools,
		...(state.registryId !== undefined ? { registryId: state.registryId } : {}),
		...(indexerManifest !== undefined ? { indexer: indexerManifest } : {}),
		...(serverManifest !== undefined ? { server: serverManifest } : {}),
		...(marginManifest !== undefined ? { margin: marginManifest } : {}),
	};
};

const groupApp = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	extras: Record<string, unknown>,
): AppManifest => {
	const dev = endpoints.find((e) => e.name === EndpointName.DEV_SERVER_PRIMARY);
	const wallet = endpoints.find((e) => e.name === EndpointName.WALLET_APP);
	return {
		extras,
		...(dev !== undefined ? { dev: toEndpointEntry(dev) } : {}),
		...(wallet !== undefined ? { wallet: toEndpointEntry(wallet) } : {}),
	};
};

// -----------------------------------------------------------------------------
// gatherManifest — read registries + Identity, return Manifest shape
// -----------------------------------------------------------------------------

/** Read every devstack registry and build the `Manifest` shape. Pure
 *  Effect computation against the canonical registries — no IO. Used by
 *  `runtime/manifest-emit.ts` (disk write) and the codegen emitters
 *  (live snapshot for `<output>/extras.ts`, `dapp-kit-config.ts`,
 *  `stack-handle.ts`, etc.).
 *
 *  `extras` is the user-supplied extras blob resolved from the
 *  `ExtrasResolved` service; this function gathers from the registries
 *  only. Callers needing extras pass them in directly. */
export const gatherManifest = (
	extras: Record<string, unknown> = {},
): Effect.Effect<
	Manifest,
	never,
	| PackageRegistry
	| EndpointRegistry
	| AccountRegistry
	| CoinRegistry
	| SuiStateRegistry
	| SealStateRegistry
	| WalrusStateRegistry
	| DeepbookStateRegistry
	| PythStateRegistry
	| PostgresStateRegistry
	| DeepbookIndexerStateRegistry
	| DeepbookServerStateRegistry
	| DeepbookMarginStateRegistry
	| Identity
> =>
	Effect.gen(function* () {
		const identity = yield* Identity;
		const pkgs = yield* PackageRegistry;
		const eps = yield* EndpointRegistry;
		const accts = yield* AccountRegistry;
		const coinsReg = yield* CoinRegistry;
		const deepbookState = yield* DeepbookStateRegistry;
		const indexerState = yield* DeepbookIndexerStateRegistry;
		const serverState = yield* DeepbookServerStateRegistry;
		const marginState = yield* DeepbookMarginStateRegistry;

		// Dedupe by name (last-wins). HMR-style re-runs re-register the
		// same name, so the last write per name should win.
		const rawPkgs = yield* pkgs.snapshot;
		const rawEps = yield* eps.snapshot;
		const rawAccts = yield* accts.snapshot;
		const rawCoins = yield* coinsReg.snapshot;
		const rawDeepbookState = yield* deepbookState.snapshot;
		const rawIndexerState = yield* indexerState.snapshot;
		const rawServerState = yield* serverState.snapshot;
		const rawMarginState = yield* marginState.snapshot;

		const dedupedPkgs = new Map(rawPkgs.map((p) => [p.name, p]));
		const dedupedEps = new Map(rawEps.map((e) => [e.name, e]));
		const dedupedAccts = new Map(rawAccts.map((a) => [a.name, a]));
		const dedupedCoins = new Map(rawCoins.map((c) => [c.name, c]));
		const lastDeepbookState = rawDeepbookState[rawDeepbookState.length - 1];
		const lastIndexerState = rawIndexerState[rawIndexerState.length - 1];
		const lastServerState = rawServerState[rawServerState.length - 1];
		const lastMarginState = rawMarginState[rawMarginState.length - 1];

		const endpoints = [...dedupedEps.values()];
		const projectionCtx: ProjectionContext = { endpoints, network: identity.network };

		// Each `defineServiceProjection` entry hides its own
		// `yield* Registry → snapshot → last record` step. Order matches
		// the historical hand-rolled order so snapshot diffs stay stable.
		const sui = yield* suiProjection.read(projectionCtx);
		const seal = yield* sealProjection.read(projectionCtx);
		const walrus = yield* walrusProjection.read(projectionCtx);
		const deepbook = groupDeepbook(
			lastDeepbookState,
			lastIndexerState,
			lastServerState,
			lastMarginState,
		);
		const pyth = yield* pythProjection.read(projectionCtx);
		const postgres = yield* postgresProjection.read(projectionCtx);

		const services: Manifest['services'] = {
			...(sui !== undefined ? { sui } : {}),
			...(seal !== undefined ? { seal } : {}),
			...(walrus !== undefined ? { walrus } : {}),
			...(deepbook !== undefined ? { deepbook } : {}),
			...(pyth !== undefined ? { pyth } : {}),
			...(postgres !== undefined ? { postgres } : {}),
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
				...(c.symbol !== undefined ? { symbol: c.symbol } : {}),
				...(c.displayName !== undefined ? { displayName: c.displayName } : {}),
				...(c.iconUrl !== undefined ? { iconUrl: c.iconUrl } : {}),
				...(c.treasuryCapId !== undefined ? { treasuryCapId: c.treasuryCapId } : {}),
				...(c.metadataId !== undefined ? { metadataId: c.metadataId } : {}),
				...(c.packageId !== undefined ? { packageId: c.packageId } : {}),
			};
		}

		const app = groupApp(endpoints, extras);

		return {
			stack: { name: identity.stack, network: identity.network, app: identity.app },
			services,
			packages,
			accounts,
			coins,
			app,
		};
	});
