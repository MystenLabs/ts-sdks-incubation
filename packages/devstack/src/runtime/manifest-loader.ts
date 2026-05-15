// `fromManifest(json)` — POJO accessor for the v4 manifest with
// transparent v3 → v4 in-memory migration.
//
// Two callers:
//   - dapp-kit's `createDevstackDappKit`, post-rewrite. Sees a v4 shape
//     regardless of what's on disk.
//   - Non-Effect TS code (browser-side scripts, post-run inspection
//     tools) that wants a typed read of the running stack without
//     standing up an Effect runtime.
//
// The migrator runs in the loader, not in the emitter. v3 emission is
// preserved for one release behind a feature flag; v4 consumers see one
// shape regardless.

import {
	type Manifest,
	type EndpointEntry,
	type SuiManifest,
	type SealManifest,
	type WalrusManifest,
	type AppManifest,
} from './manifest-schema.js';

/** What v3 manifests look like on disk. Kept as a structural shape (not
 *  a Schema) because v3 manifests are read-only inputs to the migrator —
 *  no encoding round-trip required. Optional everywhere so a partial
 *  v3 manifest still migrates cleanly. */
interface ManifestV3Shape {
	readonly version?: undefined | 3;
	readonly packages?: ReadonlyArray<{
		readonly name: string;
		readonly packageId: string;
		readonly upgradeCapId?: string;
		readonly mvrPlaceholder?: string;
		readonly captured?: Record<string, unknown>;
	}>;
	readonly endpoints?: ReadonlyArray<{
		readonly name: string;
		readonly url: string;
		readonly kind?: string;
		readonly pairUrl?: string;
	}>;
	readonly accounts?: ReadonlyArray<{ readonly name: string; readonly address: string }>;
	readonly coins?: ReadonlyArray<{
		readonly name: string;
		readonly type: string;
		readonly decimals: number;
		readonly sdkCoin: { readonly address: string; readonly type: string; readonly scalar: number };
	}>;
	readonly extras?: Record<string, unknown>;
	readonly stack?: { readonly name?: string; readonly network?: string; readonly app?: string };
}

/** Quick test for "this JSON is v4 already." Checks `version === 4`. */
const isV4 = (raw: unknown): raw is Manifest => {
	if (typeof raw !== 'object' || raw === null) return false;
	const r = raw as { version?: unknown };
	return r.version === 4;
};

/** Build a v4 `EndpointEntry` from a v3 endpoint record. v3's `pairUrl`
 *  goes into `alternates[0]` when present. */
const endpointFromV3 = (e: { url: string; pairUrl?: string }): EndpointEntry =>
	e.pairUrl !== undefined ? { url: e.url, alternates: [e.pairUrl] } : { url: e.url };

/** v3 endpoint-name → v4 sui section field. v3 uses kebab-case
 *  (`sui-rpc`, `sui-faucet`, `sui-graphql`, `sui-indexer-db`). */
const SUI_ENDPOINT_FIELDS: Record<string, keyof SuiManifest> = {
	'sui-rpc': 'rpc',
	'sui-faucet': 'faucet',
	'sui-graphql': 'graphql',
	'sui-indexer-db': 'indexerDb',
};

/** Migrate a v3 manifest to the v4 shape in memory. Used by
 *  `fromManifest(json)` when the disk format is v3. */
export function migrateV3ToV4(v3: ManifestV3Shape): Manifest {
	const endpoints = v3.endpoints ?? [];

	// services.sui — gather all `sui-*` endpoints. v3 doesn't carry chainId
	// in the manifest, so we leave it omitted; the live Devstack service
	// reads chainId from the live Sui shape, not from the manifest.
	const suiRpc = endpoints.find((e) => e.name === 'sui-rpc');
	let sui: SuiManifest | undefined;
	if (suiRpc !== undefined) {
		sui = {
			network: v3.stack?.network ?? 'localnet',
			rpc: endpointFromV3(suiRpc),
		};
		for (const e of endpoints) {
			const field = SUI_ENDPOINT_FIELDS[e.name];
			if (field !== undefined && field !== 'rpc') {
				sui = { ...sui, [field]: endpointFromV3(e) };
			}
		}
	}

	// services.seal — `seal-key-server` is the canonical v3 name.
	const sealKeyServer = endpoints.find((e) => e.name === 'seal-key-server');
	const seal: SealManifest | undefined =
		sealKeyServer !== undefined ? { keyServer: endpointFromV3(sealKeyServer) } : undefined;

	// services.walrus — needs both aggregator AND publisher.
	const walrusAggregator = endpoints.find((e) => e.name === 'walrus-aggregator');
	const walrusPublisher = endpoints.find((e) => e.name === 'walrus-publisher');
	const walrus: WalrusManifest | undefined =
		walrusAggregator !== undefined && walrusPublisher !== undefined
			? {
					aggregator: endpointFromV3(walrusAggregator),
					publisher: endpointFromV3(walrusPublisher),
				}
			: undefined;

	// app.dev / app.wallet — both kebab-cased in v3. The dev-server
	// endpoint is `frontend.dev-server` (current naming) or `dev-server`
	// (a few primitives drop the prefix); accept either.
	const devEndpoint =
		endpoints.find((e) => e.name === 'frontend.dev-server') ??
		endpoints.find((e) => e.name === 'dev-server');
	const walletEndpoint = endpoints.find((e) => e.name === 'wallet-app');
	const app: AppManifest = {
		extras: v3.extras ?? {},
		...(devEndpoint !== undefined ? { dev: endpointFromV3(devEndpoint) } : {}),
		...(walletEndpoint !== undefined ? { wallet: endpointFromV3(walletEndpoint) } : {}),
	};

	// packages — array → record keyed by name. `packageId` → `id`,
	// `mvrPlaceholder` → `mvr`. `captured` defaults to {} so consumers can
	// read it without a nullish guard.
	const packages: Record<string, Manifest['packages'][string]> = {};
	for (const p of v3.packages ?? []) {
		packages[p.name] = {
			id: p.packageId,
			captured: p.captured ?? {},
			...(p.upgradeCapId !== undefined ? { upgradeCapId: p.upgradeCapId } : {}),
			...(p.mvrPlaceholder !== undefined ? { mvr: p.mvrPlaceholder } : {}),
		};
	}

	// accounts — array → record by name.
	const accounts: Record<string, Manifest['accounts'][string]> = {};
	for (const a of v3.accounts ?? []) {
		accounts[a.name] = { address: a.address };
	}

	// coins — array → record by name.
	const coins: Record<string, Manifest['coins'][string]> = {};
	for (const c of v3.coins ?? []) {
		coins[c.name] = { type: c.type, decimals: c.decimals, sdkCoin: c.sdkCoin };
	}

	// deepbook can't be migrated mechanically — v3 records it in `extras`
	// per-app; the v4 emitter will populate it directly. Leave absent in
	// the v3 path.
	const services: Manifest['services'] = {
		...(sui !== undefined ? { sui } : {}),
		...(seal !== undefined ? { seal } : {}),
		...(walrus !== undefined ? { walrus } : {}),
	};

	return {
		version: 4,
		stack: {
			name: v3.stack?.name ?? 'main',
			network: v3.stack?.network ?? 'localnet',
			app: v3.stack?.app ?? 'unknown',
		},
		services,
		packages,
		accounts,
		coins,
		app,
	};
}

/** Read a manifest blob (v3 or v4) and return the v4 shape. Throws on
 *  malformed input (non-object root, missing required v4 fields). */
export function fromManifest(raw: unknown): Manifest {
	if (raw === null || typeof raw !== 'object') {
		throw new TypeError('fromManifest: expected an object, got ' + typeof raw);
	}
	if (isV4(raw)) return raw;
	return migrateV3ToV4(raw as ManifestV3Shape);
}
