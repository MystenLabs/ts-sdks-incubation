// `gatherManifest` — read every devstack registry + Identity and build
// the `Manifest` shape used by the on-disk `.devstack/manifest.json`,
// the codegen emitters, and any Effect-native consumer that wants a
// live snapshot.
//
// Reads `PackageRegistry`, `EndpointRegistry`, `AccountRegistry`,
// `CoinRegistry` plus the per-service state registries and the
// `Identity` service for stack/network/app fields. Shared by the
// manifest emitter (`runtime/manifest-emit.ts`) and the codegen
// emitters (`codegen/emitters/`) so the structured-conversion step
// lives in one place.

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
	type PostgresStateRecord,
	type PythStateRecord,
	type SealStateRecord,
	type SuiStateRecord,
	type WalrusStateRecord,
} from '../engine/registries.js';
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
//
// `chainId`, `seal.objectId`, `walrus.systemObjectId`, and the deepbook
// block are NOT endpoints — they live in their own per-service state
// registries (`SuiStateRegistry`, `SealStateRegistry`, etc.). The
// service factories publish into those at acquire time; the group*
// helpers below fold the latest state into the structured manifest.

/** Derive the manifest-leaf field name an endpoint projects into, given
 *  a `services.X.<leaf>` or `app.<leaf>` prefix. Reads the endpoint's
 *  `defineEndpoint(...)` declaration via the lookup registry — when a
 *  new endpoint is declared with `manifestField: { path: '...' }` the
 *  groupers pick it up automatically. Returns `undefined` for ad-hoc
 *  endpoints (no declaration, flat-only) or for declarations whose
 *  manifest path doesn't sit under the requested prefix. */
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

const groupSui = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	network: string,
	state: SuiStateRecord | undefined,
): SuiManifest | undefined => {
	const rpc = endpoints.find((e) => e.name === EndpointName.SUI_RPC);
	if (rpc === undefined) return undefined;
	let out: SuiManifest = { network, rpc: toEndpointEntry(rpc) };
	if (state !== undefined) {
		out = { ...out, chainId: state.chainId };
	}
	// Derive every `services.sui.<field>` projection from the
	// `defineEndpoint(...)` declarations — no hand-rolled SUI_FIELDS
	// table. Adding a new SUI sub-endpoint becomes a one-line
	// `defineEndpoint({manifestField: {path: 'services.sui.X'}})`.
	for (const e of endpoints) {
		const field = manifestLeafUnder(e.name, 'services.sui');
		if (field !== undefined && field !== 'rpc' && field !== 'network' && field !== 'chainId') {
			out = { ...out, [field as keyof SuiManifest]: toEndpointEntry(e) };
		}
	}
	return out;
};

const groupSeal = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	state: SealStateRecord | undefined,
): SealManifest | undefined => {
	const ks = endpoints.find((e) => e.name === EndpointName.SEAL_KEY_SERVER);
	if (ks === undefined) return undefined;
	return state !== undefined
		? { keyServer: toEndpointEntry(ks), objectId: state.objectId }
		: { keyServer: toEndpointEntry(ks) };
};

const groupWalrus = (
	endpoints: ReadonlyArray<FlatEndpoint>,
	state: WalrusStateRecord | undefined,
): WalrusManifest | undefined => {
	const agg = endpoints.find((e) => e.name === EndpointName.WALRUS_AGGREGATOR);
	const pub = endpoints.find((e) => e.name === EndpointName.WALRUS_PUBLISHER);
	if (agg === undefined || pub === undefined) return undefined;
	const base: WalrusManifest = {
		aggregator: toEndpointEntry(agg),
		publisher: toEndpointEntry(pub),
	};
	return state !== undefined ? { ...base, systemObjectId: state.systemObjectId } : base;
};

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

const groupPyth = (state: PythStateRecord | undefined): PythManifest | undefined => {
	if (state === undefined) return undefined;
	return {
		packageId: state.packageId,
		...(state.pythStateId !== undefined ? { pythStateId: state.pythStateId } : {}),
		...(state.wormholeStateId !== undefined ? { wormholeStateId: state.wormholeStateId } : {}),
		priceInfoObjectIds: state.priceInfoObjectIds,
		feeds: state.feeds,
	};
};

const groupPostgres = (state: PostgresStateRecord | undefined): PostgresManifest | undefined => {
	if (state === undefined) return undefined;
	// Strip credentials before serializing — `url` carries the password.
	// Manifest readers (consumer apps, codegen) get the endpoint host +
	// alias + db list; the password stays in-memory only.
	return {
		user: state.user,
		endpoint: { url: state.endpoint },
		containerNetwork: state.containerNetwork,
		networkAlias: state.networkAlias,
		databases: state.databases,
	};
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
// gatherManifest — read registries + Identity, return v5 Manifest shape
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
		const suiState = yield* SuiStateRegistry;
		const sealState = yield* SealStateRegistry;
		const walrusState = yield* WalrusStateRegistry;
		const deepbookState = yield* DeepbookStateRegistry;
		const pythState = yield* PythStateRegistry;
		const postgresState = yield* PostgresStateRegistry;
		const indexerState = yield* DeepbookIndexerStateRegistry;
		const serverState = yield* DeepbookServerStateRegistry;
		const marginState = yield* DeepbookMarginStateRegistry;

		// Dedupe by name (last-wins). HMR-style re-runs re-register the
		// same name, so the last write per name should win.
		const rawPkgs = yield* pkgs.snapshot;
		const rawEps = yield* eps.snapshot;
		const rawAccts = yield* accts.snapshot;
		const rawCoins = yield* coinsReg.snapshot;
		const rawSuiState = yield* suiState.snapshot;
		const rawSealState = yield* sealState.snapshot;
		const rawWalrusState = yield* walrusState.snapshot;
		const rawDeepbookState = yield* deepbookState.snapshot;
		const rawPythState = yield* pythState.snapshot;
		const rawPostgresState = yield* postgresState.snapshot;
		const rawIndexerState = yield* indexerState.snapshot;
		const rawServerState = yield* serverState.snapshot;
		const rawMarginState = yield* marginState.snapshot;

		const dedupedPkgs = new Map(rawPkgs.map((p) => [p.name, p]));
		const dedupedEps = new Map(rawEps.map((e) => [e.name, e]));
		const dedupedAccts = new Map(rawAccts.map((a) => [a.name, a]));
		const dedupedCoins = new Map(rawCoins.map((c) => [c.name, c]));
		// Per-service state registries hold at most one record per stack;
		// take the last write (matches the dedupe-by-name semantics above).
		const lastSuiState = rawSuiState[rawSuiState.length - 1];
		const lastSealState = rawSealState[rawSealState.length - 1];
		const lastWalrusState = rawWalrusState[rawWalrusState.length - 1];
		const lastDeepbookState = rawDeepbookState[rawDeepbookState.length - 1];
		const lastPythState = rawPythState[rawPythState.length - 1];
		const lastPostgresState = rawPostgresState[rawPostgresState.length - 1];
		const lastIndexerState = rawIndexerState[rawIndexerState.length - 1];
		const lastServerState = rawServerState[rawServerState.length - 1];
		const lastMarginState = rawMarginState[rawMarginState.length - 1];

		const endpoints = [...dedupedEps.values()];

		const sui = groupSui(endpoints, identity.network, lastSuiState);
		const seal = groupSeal(endpoints, lastSealState);
		const walrus = groupWalrus(endpoints, lastWalrusState);
		const deepbook = groupDeepbook(
			lastDeepbookState,
			lastIndexerState,
			lastServerState,
			lastMarginState,
		);
		const pyth = groupPyth(lastPythState);
		const postgres = groupPostgres(lastPostgresState);
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
			// Project the registry record into the manifest's CoinEntry
			// shape. Every optional field the publish-discovery pass
			// folded into the record (`symbol`, `displayName`, `iconUrl`,
			// `treasuryCapId`, `metadataId`, `packageId`) surfaces
			// directly; entries without those fields (custom `publishCoin`
			// calls from unit tests) still emit a valid `CoinEntry`. The
			// compose entry's emit-time schema validation catches a typo
			// in a new field name at write time, not at read time.
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
			version: 5 as const,
			stack: { name: identity.stack, network: identity.network, app: identity.app },
			services,
			packages,
			accounts,
			coins,
			app,
		};
	});
