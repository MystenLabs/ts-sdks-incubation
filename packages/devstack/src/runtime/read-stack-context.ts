// Unified manifest reader + projection — consolidates the four hand-rolled
// "discover manifest → JSON.parse → walk services / app" snippets used by:
//
//   - `cli/commands/fork/`          (`readManifestSuiBlock`)
//   - `cli/commands/status.ts`      (`tryReadJson` + ad-hoc sui projection)
//   - `cli/commands/manifest.ts`    (inline `JSON.parse`)
//   - `playwright/web-server.ts`    (`resolveEndpoint`)
//
// Schema-decode the parsed body against `Manifest` — a shape mismatch
// raises a typed `ManifestShapeError` at the boundary instead of NPEing
// in downstream projections.
//
// Two surfaces:
//   - `readStackContext(opts?)`     — Effect (the four CLI callsites use this)
//   - `readStackContextSync(opts?)` — sync (Playwright config-load — sync API)
//
// Both share the same parse + decode + project core. Either returns a
// `StackContext` with the canonical projections every consumer asks for.

import { Effect, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { promises as nodeFs } from 'node:fs';
import { ManifestDiscoveryError, ManifestShapeError } from '../engine/errors.js';
import { type DiscoverManifestPathOptions, discoverManifestPath } from './discover-manifest.js';
import { EndpointName } from './endpoint-names.js';
import {
	type AppManifest,
	type EndpointEntry,
	Manifest,
	type SealManifest,
	type ServicesManifest,
	type StackIdentity,
	type SuiManifest,
	type WalrusManifest,
} from './manifest-schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Read-only projection over the manifest. Field shape mirrors the
 *  manifest's `services` / `app` blocks but pre-walks the optional
 *  nesting so callers don't repeat the `manifest.services?.sui?.rpc?.url`
 *  cascade. Use `endpoint(name)` to resolve a flat endpoint name (e.g.
 *  `'sui-rpc'`, `'frontend.dev-server'`) into the manifest URL. */
export interface StackContext {
	/** Stack identity — name / network / app. Mirrors `manifest.stack`. */
	readonly stack: StackIdentity;
	/** Absolute path to the on-disk `manifest.json` the projection
	 *  derived from. */
	readonly manifestPath: string;
	/** The fully-decoded manifest. Schema-validated at the boundary —
	 *  no shape drift past this point. */
	readonly manifest: Manifest;
	/** `services.sui` block (when published) — for the fork CLI's gRPC
	 *  lookup and the `status` command's chain block. */
	readonly sui: SuiManifest | undefined;
	/** `services.seal`, `services.walrus` — mirrored for symmetry. */
	readonly seal: SealManifest | undefined;
	readonly walrus: WalrusManifest | undefined;
	/** `app.dev` / `app.wallet` — the two well-known app endpoints. */
	readonly dev: EndpointEntry | undefined;
	readonly wallet: EndpointEntry | undefined;
	/** Whole `services` block for callers that need a service the
	 *  convenience projection didn't surface. */
	readonly services: ServicesManifest;
	/** Whole `app` block. */
	readonly app: AppManifest;
	/** Resolve a flat endpoint name to its URL. Mirrors the lookup table
	 *  that previously lived inline in `playwright/web-server.ts`. Returns
	 *  `undefined` when the named endpoint isn't in the manifest. */
	readonly endpoint: (name: string) => EndpointEntry | undefined;
}

export interface ReadStackContextOptions extends DiscoverManifestPathOptions {
	/** Caller-supplied explicit manifest path. When set, bypasses the
	 *  walk-up (still validates the file exists). Equivalent to passing
	 *  `override:` to `discoverManifestPath`. Kept as a named field
	 *  because the CLI commands historically named it `manifestPath` /
	 *  `--config-path`. */
	readonly manifestPath?: string;
}

// ---------------------------------------------------------------------------
// Core projection + decode (shared by both sync and Effect surfaces)
// ---------------------------------------------------------------------------

const decodeManifest = Schema.decodeUnknownSync(Manifest);

/** Project the decoded manifest into a `StackContext`. Pulls the
 *  convenience slices and wires the `endpoint()` lookup. */
const project = (manifest: Manifest, manifestPath: string): StackContext => {
	// Build the flat endpoint table from the typed manifest. Mirrors
	// `runtime/endpoint-names.ts`'s `defineEndpoint(...)` declarations —
	// keep them in sync when adding a new well-known endpoint.
	const flat: Record<string, EndpointEntry> = {};
	const sui = manifest.services.sui;
	if (sui !== undefined) {
		flat[EndpointName.SUI_RPC] = sui.rpc;
		if (sui.faucet !== undefined) flat[EndpointName.SUI_FAUCET] = sui.faucet;
		if (sui.graphql !== undefined) flat[EndpointName.SUI_GRAPHQL] = sui.graphql;
		if (sui.indexerDb !== undefined) flat[EndpointName.SUI_INDEXER_DB] = sui.indexerDb;
	}
	const seal = manifest.services.seal;
	if (seal !== undefined) flat[EndpointName.SEAL_KEY_SERVER] = seal.keyServer;
	const walrus = manifest.services.walrus;
	if (walrus !== undefined) {
		flat[EndpointName.WALRUS_AGGREGATOR] = walrus.aggregator;
		flat[EndpointName.WALRUS_PUBLISHER] = walrus.publisher;
	}
	if (manifest.app.dev !== undefined) flat[EndpointName.DEV_SERVER_PRIMARY] = manifest.app.dev;
	if (manifest.app.wallet !== undefined) flat[EndpointName.WALLET_APP] = manifest.app.wallet;
	if (manifest.services.postgres !== undefined) {
		flat[EndpointName.POSTGRES] = manifest.services.postgres.endpoint;
	}
	return {
		stack: manifest.stack,
		manifestPath,
		manifest,
		sui,
		seal,
		walrus,
		dev: manifest.app.dev,
		wallet: manifest.app.wallet,
		services: manifest.services,
		app: manifest.app,
		endpoint: (name: string) => flat[name],
	};
};

/** Parse + Schema-decode the raw manifest body. Surfaces parse vs decode
 *  failures as distinct `ManifestShapeError` phases so the caller can
 *  print a precise recovery hint (corrupt JSON vs shape mismatch). */
const parseAndDecode = (raw: string, manifestPath: string): Manifest => {
	let parsed: unknown;
	try {
		// Manifest is all-strings (no bigint scalars). If a future
		// schema folds bigint fields, wire `jsonBigintReviver` here.
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new ManifestShapeError({
			phase: 'parse',
			path: manifestPath,
			message:
				`[devstack] manifest at ${manifestPath} is not valid JSON. ` +
				`This usually means the file was truncated mid-write or hand-edited. ` +
				`RECOVERY: \`rm ${manifestPath} && devstack apply\` to regenerate.`,
			cause,
		});
	}
	try {
		return decodeManifest(parsed);
	} catch (cause) {
		throw new ManifestShapeError({
			phase: 'shape',
			path: manifestPath,
			message:
				`[devstack] manifest at ${manifestPath} does not match the manifest schema ` +
				`(hand-edited shape — missing required \`services\` / \`app\` fields). ` +
				`RECOVERY: \`rm -rf .devstack/manifest.json .devstack/stacks/*/manifest.json && devstack apply\` ` +
				`to regenerate.`,
			cause,
		});
	}
};

// ---------------------------------------------------------------------------
// Sync surface — Playwright config-load is sync
// ---------------------------------------------------------------------------

/** Resolve the manifest path per `discoverManifestPath` semantics, with
 *  the caller's `manifestPath:` taking precedence over the walk-up.
 *  Throws `ManifestDiscoveryError` (with `{required: true}`) on miss so
 *  the sync surface can be wrapped in `Effect.try`. */
const resolveManifestPathSync = (opts: ReadStackContextOptions): string => {
	const override = opts.manifestPath ?? opts.override;
	const resolved = discoverManifestPath({
		...opts,
		...(override !== undefined ? { override } : {}),
		required: true,
	});
	// `required: true` throws on miss; the `string | undefined` type is
	// load-bearing for the `required: false` path which we don't use here.
	if (resolved === undefined) {
		// Unreachable — `required: true` throws — but keeps the type narrow.
		throw new ManifestDiscoveryError({
			phase: 'required-missing',
			message: '[devstack] manifest discovery returned undefined despite required: true',
		});
	}
	return resolved;
};

/** Sync read + decode. Throws `ManifestDiscoveryError` (no manifest on
 *  disk) or `ManifestShapeError` (manifest exists but is stale / corrupt).
 *  Used by `playwright/web-server.ts`. */
export const readStackContextSync = (opts: ReadStackContextOptions = {}): StackContext => {
	const manifestPath = resolveManifestPathSync(opts);
	const raw = readFileSync(manifestPath, 'utf8');
	const manifest = parseAndDecode(raw, manifestPath);
	return project(manifest, manifestPath);
};

// ---------------------------------------------------------------------------
// Effect surface — CLI commands use this
// ---------------------------------------------------------------------------

/** Effect-wrapped reader. Same semantics as `readStackContextSync` — the
 *  failure channel surfaces `ManifestDiscoveryError | ManifestShapeError`
 *  so CLI callers can `Effect.catchTags` for structured recovery. */
export const readStackContext = (
	opts: ReadStackContextOptions = {},
): Effect.Effect<StackContext, ManifestDiscoveryError | ManifestShapeError> =>
	Effect.gen(function* () {
		const manifestPath = yield* Effect.try({
			try: () => resolveManifestPathSync(opts),
			catch: (cause) => {
				if (cause instanceof ManifestDiscoveryError) return cause;
				if (cause instanceof ManifestShapeError) return cause;
				// `discoverManifestPath` only throws `ManifestDiscoveryError`
				// when `required: true`. Anything else is a defect — surface
				// as a discovery error rather than swallowing.
				return new ManifestDiscoveryError({
					phase: 'required-missing',
					message: `[devstack] unexpected error resolving manifest path: ${String(cause)}`,
					cause,
				});
			},
		});
		const raw = yield* Effect.tryPromise({
			try: () => nodeFs.readFile(manifestPath, 'utf8'),
			catch: (cause) =>
				new ManifestShapeError({
					phase: 'parse',
					path: manifestPath,
					message: `[devstack] failed to read manifest at ${manifestPath}: ${String(cause)}`,
					cause,
				}),
		});
		const manifest = yield* Effect.try({
			try: () => parseAndDecode(raw, manifestPath),
			catch: (cause) => cause as ManifestShapeError,
		});
		return project(manifest, manifestPath);
	});
