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

import { jsonBigintReviver } from '../engine/json-bigint.js';
import {
	type Manifest,
	type EndpointEntry,
	type SuiManifest,
	type SealManifest,
	type WalrusManifest,
	type AppManifest,
} from './manifest-schema.js';

/** The highest manifest schema version this build of devstack natively
 *  understands. Bump when a new top-level shape lands AND its loader
 *  branch is in place. Forward-compat: manifests with a higher version
 *  emit a warning and fall through to best-effort decoding so a
 *  newer-supervisor / older-consumer mix doesn't hard-crash on
 *  unrecognized optional fields. */
const EXPECTED_VERSION = 4;

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

/** Returns the numeric `version` field if it's a finite number, or
 *  `undefined` otherwise. Used by the forward-compat branch to decide
 *  whether a future-version manifest should be best-effort decoded. */
const numericVersion = (raw: unknown): number | undefined => {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const r = raw as { version?: unknown };
	return typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : undefined;
};

/** Quick test for "this JSON is a v3 manifest." Either `version === 3`
 *  or no `version` field at all (the original unversioned shape). */
const isV3 = (raw: unknown): raw is ManifestV3Shape => {
	if (typeof raw !== 'object' || raw === null) return false;
	const r = raw as { version?: unknown };
	return r.version === undefined || r.version === 3;
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

/** Options for `fromManifest()`. */
export interface FromManifestOptions {
	/** When `true`, hard-rejects ANY version that isn't exactly v4 (after
	 *  v3 → v4 migration). Use this in CI safeguards or other contexts
	 *  where a version skew is itself a bug. Default `false` —
	 *  newer-than-known manifests log a warning and fall through to
	 *  best-effort decoding so an older consumer doesn't crash on a
	 *  newer supervisor's optional-field additions. */
	readonly strict?: boolean;
}

/** Read a manifest blob (v3 or v4) and return the v4 shape.
 *
 *  Accepts either a parsed object OR a raw JSON string; strings are
 *  parsed with `jsonBigintReviver` so `{__bigint: "123"}` round-trips
 *  back to a `bigint` instead of an object literal — consumers
 *  expecting bigint shapes (Coin scalars, gas budgets) get the right
 *  type without remembering to wire the reviver themselves.
 *
 *  Forward-compat: a manifest with `version > EXPECTED_VERSION` is
 *  best-effort decoded (the schema's added/optional fields are simply
 *  ignored by typed readers) with a warning, unless `opts.strict` is
 *  set. A `version < EXPECTED_VERSION` falls into the v3 → v4 migrator;
 *  versions we don't have a migrator for hard-fail. */
export function fromManifest(raw: unknown, opts: FromManifestOptions = {}): Manifest {
	let parsed: unknown;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw, jsonBigintReviver);
		} catch (cause) {
			throw new TypeError(
				`fromManifest: failed to parse string input as JSON: ${(cause as Error).message}`,
			);
		}
	} else {
		parsed = raw;
	}
	if (parsed === null || typeof parsed !== 'object') {
		throw new TypeError('fromManifest: expected an object, got ' + typeof parsed);
	}
	if (isV4(parsed)) return parsed;
	if (isV3(parsed)) return migrateV3ToV4(parsed);

	const version = numericVersion(parsed);
	const rawVersion = (parsed as { version?: unknown }).version;

	// Forward-compat: a future manifest version we don't know about.
	// Without strict mode we treat it as v4 (optional/added fields the
	// schema doesn't know will be ignored by downstream typed readers,
	// which is the load-bearing property here — a newer supervisor
	// writing `version: 5` with a few extra `services.*` fields
	// shouldn't crash an older example app's `fromManifest` call). With
	// strict mode (CI), fail loudly so the version skew surfaces.
	if (version !== undefined && version > EXPECTED_VERSION) {
		if (opts.strict) {
			throw new TypeError(
				`fromManifest: manifest version ${version} is newer than this build supports ` +
					`(expected ${EXPECTED_VERSION}). Update @mysten-incubation/devstack ` +
					`or pass { strict: false } to opt into best-effort forward-compat decoding.`,
			);
		}
		console.warn(
			`[devstack] fromManifest: newer manifest version ${version}, treating as v${EXPECTED_VERSION}. ` +
				`Unknown fields will be ignored. Update @mysten-incubation/devstack to read the new shape natively.`,
		);
		// Stamp `version: EXPECTED_VERSION` so the returned object
		// satisfies the v4 `Manifest` type, then trust the structural
		// overlap with v4 to carry the rest. Downstream typed reads
		// (services.sui.rpc.url, packages[name].id, etc.) just work
		// because v4's required fields are unlikely to disappear in a
		// minor version bump; if they DO disappear, the consumer hits
		// a `TypeError` on field access, not a silent miscompute.
		return { ...(parsed as Manifest), version: EXPECTED_VERSION };
	}

	// Unknown / non-numeric / older-than-v3 version. No migrator
	// covers this, so error regardless of strict mode.
	throw new TypeError(
		`fromManifest: unknown manifest version ${JSON.stringify(rawVersion)} ` +
			`(supported: 3, ${EXPECTED_VERSION}). Update @mysten-incubation/devstack.`,
	);
}
