// Stack-context surface for the Playwright preset — thin wrapper
// over `runtime/`'s sync read API.
//
// Playwright config-load is synchronous; it runs BEFORE the supervisor
// spawns, so the preset MUST support a cold-start fallback that picks
// a conventional URL when the manifest isn't on disk yet. The
// decode + version-gate + walk-up live in `runtime/`; this surface
// re-shapes the result into playwright-flavored typed errors and the
// endpoint-name accessors in-spec helpers use.

import {
	BUILT_IN_ENDPOINT_ALIASES,
	DEFAULT_ROUTER_ENTRYPOINT_PORT,
	builtInConventionalRoutes,
	discoverManifestPath as runtimeDiscoverManifestPath,
	coldStartUrl as runtimeColdStartUrl,
	EndpointRegistry,
	manifestEnvelopeFromStackContext,
	ManifestDiscoveryError,
	ManifestShapeError,
	readStackContext as readStackContextRuntime,
	type DiscoverManifestPathOptions,
	type EndpointEntry,
	type ManifestEnvelope,
	type ResolvedEndpoint as RuntimeResolvedEndpoint,
	type StackContext as RuntimeStackContext,
} from '../runtime/index.ts';
import {
	PlaywrightEndpointNotFoundError,
	PlaywrightManifestDiscoveryError,
	PlaywrightManifestShapeError,
} from './errors.ts';

/** Centralized env-var names this surface consults. Kept in sync with
 *  the CLI's `ENV_VARS` table. */
export const PLAYWRIGHT_ENV = {
	STATE_DIR: 'DEVSTACK_STATE_DIR',
	STACK: 'DEVSTACK_STACK',
	MANIFEST_PATH: 'DEVSTACK_MANIFEST_PATH',
	ROUTER_HOST_SUFFIX: 'DEVSTACK_ROUTER_HOST_SUFFIX',
	ROUTER_PORT: 'DEVSTACK_ROUTER_PORT',
} as const;

export interface ResolveStackContextOptions {
	/** Working directory to start the walk-up from. */
	readonly cwd?: string;
	/** Explicit manifest path. Wins over discovery + env. */
	readonly manifestPath?: string;
	/** Explicit `<stateDir>` root override. Combined with `stack` to
	 *  form `<root>/stacks/<stack>/manifest.json`. */
	readonly stateDir?: string;
	/** Stack name override. Defaults to env `DEVSTACK_STACK`. */
	readonly stack?: string;
	/** Env bag (defaults to `process.env`). Injectable for tests. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface StackContext {
	readonly manifest: ManifestEnvelope;
	readonly manifestPath: string;
	readonly endpointNames: ReadonlyArray<string>;
	readonly manifestEndpointKeys: ReadonlyArray<string>;
	readonly endpoint: (endpointNameOrAlias: string) => string;
	readonly endpointMaybe: (endpointNameOrAlias: string) => string | null;
	readonly endpointEntry: (endpointNameOrAlias: string) => EndpointEntry;
}

export interface ResolvedEndpoint {
	readonly url: string;
	readonly source: 'manifest' | 'conventional';
	readonly endpointKey: string;
	readonly endpointName: string;
}

// Endpoint aliases + default port live in `runtime/conventional-routes.ts`
// so vitest / Playwright / any future build integration share one table.
// Playwright contributes nothing of its own here — every per-endpoint
// fact is substrate-supplied.

export const playwrightEndpointNameFor = (endpointNameOrAlias: string): string => {
	const aliases: Readonly<Record<string, string>> = BUILT_IN_ENDPOINT_ALIASES;
	return aliases[endpointNameOrAlias] ?? endpointNameOrAlias;
};

const endpointRegistryFromEnvelope = (envelope: ManifestEnvelope): EndpointRegistry => {
	const entries: RuntimeResolvedEndpoint[] = [];
	for (const raw of Object.values(envelope.endpoints)) {
		entries.push({
			name: raw.name,
			url: raw.url,
			displayUrl: raw.displayUrl,
			wireProtocol: raw.wireProtocol,
			pluginKey: raw.pluginKey,
			endpointKey: raw.endpointKey,
		});
	}
	return new EndpointRegistry(entries);
};

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

const buildRuntimeDiscoverOpts = (
	options: ResolveStackContextOptions,
): DiscoverManifestPathOptions => {
	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const stack = options.stack ?? env[PLAYWRIGHT_ENV.STACK] ?? 'main';
	const stateDir = options.stateDir ?? env[PLAYWRIGHT_ENV.STATE_DIR];
	return {
		env,
		stack,
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.manifestPath !== undefined ? { override: options.manifestPath } : {}),
		...(stateDir !== undefined && stateDir !== '' ? { stateDir } : {}),
	};
};

/**
 * Find the stack-scoped manifest by walking up from `cwd` looking for
 * `.devstack/stacks/<stack>/manifest.json`. Returns the absolute path
 * + the list of paths probed, or `null` on miss.
 */
export const discoverManifestPath = (
	options: ResolveStackContextOptions = {},
): { readonly path: string; readonly searched: ReadonlyArray<string> } | null => {
	const path = runtimeDiscoverManifestPath(buildRuntimeDiscoverOpts(options));
	if (path === undefined) return null;
	// Runtime resolver doesn't surface intermediate probe paths today.
	// We expose the resolved path in the `searched` array so the
	// PlaywrightManifestDiscoveryError can still cite at least one
	// concrete path.
	return { path, searched: [path] };
};

// -----------------------------------------------------------------------------
// Synchronous read + decode
// -----------------------------------------------------------------------------

/**
 * Synchronously read + decode the manifest at `manifestPath`. Throws
 * `PlaywrightManifestShapeError` on JSON-parse or schema-decode
 * failure, or version mismatch. Used by callers that already know
 * the path (preset's webServer.url resolution + global-setup).
 */
export const readManifestSync = (manifestPath: string): ManifestEnvelope => {
	try {
		return manifestEnvelopeFromStackContext(readStackContextRuntime({ manifestPath }));
	} catch (cause) {
		if (cause instanceof ManifestShapeError) {
			throw new PlaywrightManifestShapeError({
				message:
					cause.phase === 'version'
						? `manifest at ${manifestPath} version mismatch: ${cause.message}`
						: `manifest at ${manifestPath} does not match the envelope schema`,
				manifestPath,
				phase: cause.phase === 'version' ? 'version-mismatch' : 'shape',
				recoveryHint:
					cause.phase === 'version'
						? `Re-run \`devstack up\` to write a manifest at the current version, ` +
							`or upgrade @mysten-incubation/devstack to a build-integration ` +
							`that understands the new envelope.`
						: `Delete \`${manifestPath}\` and run \`devstack up\`. If the error ` +
							`persists, the build-integration is older than the supervisor.`,
				cause,
			});
		}
		if (cause instanceof ManifestDiscoveryError) {
			// A discovery error (missing file at a known path) is NOT a
			// shape error — surface the typed discovery tag so callers
			// can `catchTag` the two failure modes independently.
			throw new PlaywrightManifestDiscoveryError({
				message:
					cause.message !== ''
						? cause.message
						: `manifest at ${manifestPath} could not be read`,
				searchedPaths: cause.path !== undefined ? [cause.path] : [manifestPath],
				recoveryHint:
					`Confirm the file exists and is readable. Run \`devstack up\` to ` +
					`regenerate it if the supervisor was interrupted mid-write.`,
			});
		}
		throw cause;
	}
};

// -----------------------------------------------------------------------------
// Conventional URL fallback
// -----------------------------------------------------------------------------

/**
 * Cold-start URL fallback for endpoints with a conventional host
 * pattern. Playwright config-load runs BEFORE the supervisor writes
 * the manifest; the preset MUST be able to resolve a `baseURL`
 * without a manifest read.
 *
 * The route table shape matches `runtime/coldStartUrl`; Playwright
 * only supplies its conventional endpoint hints while the shared
 * runtime helper owns host formatting.
 */
export const conventionalUrlFor = (
	endpointKey: string,
	opts: {
		readonly stack?: string;
		readonly hostSuffix?: string;
		readonly port?: number;
		readonly app?: string;
		readonly cwd?: string;
		readonly env?: Readonly<Record<string, string | undefined>>;
	} = {},
): string | null => {
	const stack = opts.stack ?? 'main';
	const env = opts.env ?? (process.env as Record<string, string | undefined>);
	const envPort = Number.parseInt(env[PLAYWRIGHT_ENV.ROUTER_PORT] ?? '', 10);
	const resolvedPort =
		opts.port ??
		(Number.isFinite(envPort) && envPort > 0 ? envPort : undefined) ??
		DEFAULT_ROUTER_ENTRYPOINT_PORT;

	if (!Number.isFinite(resolvedPort) || resolvedPort <= 0) {
		return null;
	}

	const routes = builtInConventionalRoutes(resolvedPort);
	if (!routes.has(endpointKey)) return null;

	return runtimeColdStartUrl(endpointKey, {
		routes,
		stack,
		...(opts.app !== undefined ? { app: opts.app } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.hostSuffix !== undefined ? { hostSuffix: opts.hostSuffix } : {}),
		// Thread the caller env bag so `runtimeColdStartUrl` resolves
		// `DEVSTACK_STACK` / `DEVSTACK_APP` from the test-injected
		// fixture rather than silently falling back to `process.env`.
		...(opts.env !== undefined ? { env: opts.env } : {}),
	});
};

// -----------------------------------------------------------------------------
// Public readers
// -----------------------------------------------------------------------------

/**
 * Synchronously resolve the full stack context. Throws on missing
 * manifest (no cold-start fallback here — caller wants the typed
 * envelope, not a guessed URL).
 */
export const readStackContext = (options: ResolveStackContextOptions = {}): StackContext => {
	try {
		const ctx = readStackContextRuntime(buildRuntimeDiscoverOpts(options));
		return projectFromRuntime(ctx);
	} catch (err) {
		if (err instanceof ManifestDiscoveryError) {
			throw new PlaywrightManifestDiscoveryError({
				message: 'no manifest found along walk-up path or env override',
				searchedPaths: err.path !== undefined ? [err.path] : [],
				recoveryHint:
					`Run \`devstack up\` from your example app's directory to write ` +
					`the manifest, or set DEVSTACK_MANIFEST_PATH to an explicit path.`,
			});
		}
		if (err instanceof ManifestShapeError) {
			throw new PlaywrightManifestShapeError({
				message: err.message,
				manifestPath: err.path,
				phase: err.phase === 'version' ? 'version-mismatch' : err.phase,
				recoveryHint: `Delete \`${err.path}\` and run \`devstack up\` to regenerate.`,
				cause: err,
			});
		}
		throw err;
	}
};

const projectFromRuntime = (ctx: RuntimeStackContext): StackContext => {
	const envelope = manifestEnvelopeFromStackContext(ctx);
	return makeStackContext(envelope, ctx.manifestPath);
};

/** Project an in-memory envelope (test fixtures use this) into the
 *  same accessor shape as the on-disk read. */
export const makeStackContext = (
	envelope: ManifestEnvelope,
	manifestPath: string,
): StackContext => {
	const endpoints = endpointRegistryFromEnvelope(envelope);
	const manifestEndpointKeys = Object.keys(envelope.endpoints).sort();
	const endpointNames = endpoints.names();
	const notFound = (endpointKey: string, endpointName: string): PlaywrightEndpointNotFoundError =>
		new PlaywrightEndpointNotFoundError({
			message:
				`no endpoint \`${endpointKey}\` (resolved endpoint name \`${endpointName}\`) ` +
				`in manifest at ${manifestPath}`,
			endpointKey,
			endpointName,
			available: endpointNames,
			manifestKeys: manifestEndpointKeys,
			recoveryHint:
				`Available endpoint names: ${endpointNames.join(', ') || '(none)'}. ` +
				`Raw manifest keys: ${manifestEndpointKeys.join(', ') || '(none)'}. ` +
				`Check the plugin emitting this endpoint is present in your stack, ` +
				`or check for a typo in the endpoint name.`,
		});
	const findEndpoint = (endpointNameOrAlias: string): RuntimeResolvedEndpoint | undefined =>
		endpoints.byName(playwrightEndpointNameFor(endpointNameOrAlias));
	const rawEntryFor = (resolved: RuntimeResolvedEndpoint): EndpointEntry => {
		const byMapKey = envelope.endpoints[resolved.endpointKey];
		if (byMapKey !== undefined) return byMapKey;
		const byEntryKey = Object.values(envelope.endpoints).find(
			(entry) => entry.endpointKey === resolved.endpointKey,
		);
		if (byEntryKey !== undefined) return byEntryKey;
		return {
			name: resolved.name,
			url: resolved.url,
			displayUrl: resolved.displayUrl,
			wireProtocol: resolved.wireProtocol,
			pluginKey: resolved.pluginKey,
			endpointKey: resolved.endpointKey,
		};
	};

	return {
		manifest: envelope,
		manifestPath,
		endpointNames,
		manifestEndpointKeys,
		endpoint: (endpointNameOrAlias: string): string => {
			const endpointName = playwrightEndpointNameFor(endpointNameOrAlias);
			const entry = findEndpoint(endpointNameOrAlias);
			if (entry === undefined) {
				throw notFound(endpointNameOrAlias, endpointName);
			}
			return entry.url;
		},
		endpointMaybe: (endpointNameOrAlias: string): string | null =>
			findEndpoint(endpointNameOrAlias)?.url ?? null,
		endpointEntry: (endpointNameOrAlias: string): EndpointEntry => {
			const endpointName = playwrightEndpointNameFor(endpointNameOrAlias);
			const entry = findEndpoint(endpointNameOrAlias);
			if (entry === undefined) {
				throw notFound(endpointNameOrAlias, endpointName);
			}
			return rawEntryFor(entry);
		},
	};
};

/**
 * Resolve a URL for a single endpoint with cold-start fallback to the
 * conventional URL when the manifest is absent. Throws when both the
 * manifest and the conventional table miss.
 */
export const resolveEndpointUrl = (
	endpointNameOrAlias: string,
	options: ResolveStackContextOptions & {
		readonly port?: number;
		readonly hostSuffix?: string;
	} = {},
): ResolvedEndpoint => {
	const endpointName = playwrightEndpointNameFor(endpointNameOrAlias);
	let ctx: StackContext | undefined;
	try {
		ctx = readStackContext(options);
	} catch (err) {
		if (!(err instanceof PlaywrightManifestDiscoveryError)) throw err;
	}
	if (ctx !== undefined) {
		const entry = ctx.endpointEntry(endpointNameOrAlias);
		return { url: entry.url, source: 'manifest', endpointKey: entry.endpointKey, endpointName };
	}

	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const stack = options.stack ?? env[PLAYWRIGHT_ENV.STACK] ?? 'main';
	const fallback = conventionalUrlFor(endpointNameOrAlias, {
		stack,
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.hostSuffix !== undefined
			? { hostSuffix: options.hostSuffix }
			: env[PLAYWRIGHT_ENV.ROUTER_HOST_SUFFIX] !== undefined
				? { hostSuffix: env[PLAYWRIGHT_ENV.ROUTER_HOST_SUFFIX] }
				: {}),
		...(options.port !== undefined ? { port: options.port } : {}),
		...(options.env !== undefined ? { env: options.env } : {}),
	});
	if (fallback !== null) {
		return {
			url: fallback,
			source: 'conventional',
			endpointKey: endpointNameOrAlias,
			endpointName,
		};
	}

	throw new PlaywrightManifestDiscoveryError({
		message:
			`no manifest found and no conventional fallback for endpoint ` +
			`\`${endpointNameOrAlias}\` (resolved endpoint name \`${endpointName}\`)`,
		searchedPaths: [],
		endpointKey: endpointNameOrAlias,
		recoveryHint:
			`Run \`devstack up\` to materialize the manifest before invoking ` +
			`playwright, or pass an explicit \`baseURL\`.`,
	});
};
