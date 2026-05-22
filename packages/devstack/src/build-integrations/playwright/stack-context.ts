// Stack-context surface for the Playwright preset — thin wrapper
// over `runtime/`'s sync read API.
//
// Playwright config-load is synchronous; it runs BEFORE the supervisor
// spawns, so the preset MUST support a cold-start fallback that picks
// a conventional URL when the manifest isn't on disk yet. The
// decode + version-gate + walk-up live in `runtime/`; this surface
// re-shapes the result into playwright-flavored typed errors and the
// `endpoint(key)` accessor in-spec helpers use.

import {
	discoverManifestPath as runtimeDiscoverManifestPath,
	coldStartUrl as runtimeColdStartUrl,
	conventionalRoutesFromHints,
	manifestEnvelopeFromStackContext,
	ManifestDiscoveryError,
	ManifestShapeError,
	readStackContext as readStackContextRuntime,
	type DiscoverManifestPathOptions,
	type StackContext as RuntimeStackContext,
} from '../runtime/index.ts';
import type { EndpointEntry, ManifestEnvelope } from '../../substrate/manifest.ts';
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
	readonly endpoint: (endpointKey: string) => string;
	readonly endpointMaybe: (endpointKey: string) => string | null;
	readonly endpointEntry: (endpointKey: string) => EndpointEntry;
}

export interface ResolvedEndpoint {
	readonly url: string;
	readonly source: 'manifest' | 'conventional';
	readonly endpointKey: string;
}

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
			throw new PlaywrightManifestShapeError({
				message: `failed to read manifest at ${manifestPath}`,
				manifestPath,
				phase: 'parse',
				recoveryHint:
					`Confirm the file exists and is readable. Run \`devstack up\` to ` +
					`regenerate it if the supervisor was interrupted mid-write.`,
				cause,
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
	} = {},
): string | null => {
	const stack = opts.stack ?? 'main';
	const port = opts.port ?? Number.parseInt(process.env[PLAYWRIGHT_ENV.ROUTER_PORT] ?? '', 10);

	if (!Number.isFinite(port) || port <= 0) return null;

	const routes = conventionalRoutesFromHints(
		[
			{ endpoint: 'app', service: 'dev' },
			{ endpoint: 'sui-rpc', service: 'sui-rpc' },
			{ endpoint: 'sui-faucet', service: 'sui-faucet' },
			{ endpoint: 'walrus-aggregator', service: 'walrus-aggregator' },
			{ endpoint: 'walrus-publisher', service: 'walrus-publisher' },
			{ endpoint: 'seal', service: 'seal' },
			{ endpoint: 'wallet', service: 'wallet' },
		],
		port,
	);
	if (!routes.has(endpointKey)) return null;

	return runtimeColdStartUrl(endpointKey, {
		routes,
		stack,
		...(opts.app !== undefined ? { app: opts.app } : {}),
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		...(opts.hostSuffix !== undefined ? { hostSuffix: opts.hostSuffix } : {}),
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
): StackContext => ({
	manifest: envelope,
	manifestPath,
	endpoint: (endpointKey: string): string => {
		const entry = envelope.endpoints[endpointKey];
		if (entry === undefined) {
			throw new PlaywrightEndpointNotFoundError({
				message: `no endpoint \`${endpointKey}\` in manifest at ${manifestPath}`,
				endpointKey,
				available: Object.keys(envelope.endpoints),
				recoveryHint:
					`Check the plugin emitting this endpoint is present in your stack, ` +
					`or check for a typo in the endpoint key.`,
			});
		}
		return entry.url;
	},
	endpointMaybe: (endpointKey: string): string | null =>
		envelope.endpoints[endpointKey]?.url ?? null,
	endpointEntry: (endpointKey: string): EndpointEntry => {
		const entry = envelope.endpoints[endpointKey];
		if (entry === undefined) {
			throw new PlaywrightEndpointNotFoundError({
				message: `no endpoint \`${endpointKey}\` in manifest at ${manifestPath}`,
				endpointKey,
				available: Object.keys(envelope.endpoints),
				recoveryHint:
					`Check the plugin emitting this endpoint is present in your stack, ` +
					`or check for a typo in the endpoint key.`,
			});
		}
		return entry;
	},
});

/**
 * Resolve a URL for a single endpoint with cold-start fallback to the
 * conventional URL when the manifest is absent. Throws when both the
 * manifest and the conventional table miss.
 */
export const resolveEndpointUrl = (
	endpointKey: string,
	options: ResolveStackContextOptions & {
		readonly port?: number;
		readonly hostSuffix?: string;
	} = {},
): ResolvedEndpoint => {
	let ctx: StackContext | undefined;
	try {
		ctx = readStackContext(options);
	} catch (err) {
		if (!(err instanceof PlaywrightManifestDiscoveryError)) throw err;
	}
	if (ctx !== undefined) {
		const entry = ctx.manifest.endpoints[endpointKey];
		if (entry !== undefined) {
			return { url: entry.url, source: 'manifest', endpointKey };
		}
		throw new PlaywrightEndpointNotFoundError({
			message: `no endpoint \`${endpointKey}\` in manifest at ${ctx.manifestPath}`,
			endpointKey,
			available: Object.keys(ctx.manifest.endpoints),
			recoveryHint:
				`Check the plugin emitting this endpoint is present in your stack, ` +
				`or check for a typo in the endpoint key.`,
		});
	}

	const env = options.env ?? (process.env as Record<string, string | undefined>);
	const stack = options.stack ?? env[PLAYWRIGHT_ENV.STACK] ?? 'main';
	const fallback = conventionalUrlFor(endpointKey, {
		stack,
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.hostSuffix !== undefined
			? { hostSuffix: options.hostSuffix }
			: env[PLAYWRIGHT_ENV.ROUTER_HOST_SUFFIX] !== undefined
				? { hostSuffix: env[PLAYWRIGHT_ENV.ROUTER_HOST_SUFFIX] }
				: {}),
		...(options.port !== undefined ? { port: options.port } : {}),
	});
	if (fallback !== null) {
		return { url: fallback, source: 'conventional', endpointKey };
	}

	throw new PlaywrightManifestDiscoveryError({
		message: `no manifest found and no conventional fallback for endpoint \`${endpointKey}\``,
		searchedPaths: [],
		endpointKey,
		recoveryHint:
			`Run \`devstack up\` to materialize the manifest before invoking ` +
			`playwright, or pass an explicit \`baseURL\` to ` +
			`defineDevstackPlaywrightConfig.`,
	});
};
