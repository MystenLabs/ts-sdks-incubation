// Stack-context loader for the vitest integration — thin wrapper
// over `runtime/readStackContext`.
//
// The vitest preset is a passive reader of the supervisor's manifest.
// Discovery, decode, and version-gate live in `runtime/`; this module
// only:
//   - resolves the vitest-flavored env contract (`DEVSTACK_RUNTIME_ROOT`
//     plus legacy `DEVSTACK_STATE_DIR` alias),
//   - exposes the manifest plus `endpoint(name)` / `displayEndpoint(name)`
//     convenience accessors test bodies use,
//   - re-shapes the canonical error tags into the vitest-flavored union
//     (`VitestManifestNotFoundError` / `VitestManifestShapeError`) so
//     caller `catchTag` flows stay stable.

import {
	ManifestDiscoveryError,
	ManifestShapeError,
	readStackContext as readStackContextRuntime,
	type StackContext as RuntimeStackContext,
} from '../runtime/index.ts';
import type { ManifestEnvelope } from '../../substrate/manifest.ts';
import { VITEST_ENV_VARS } from './env.ts';
import { VitestManifestNotFoundError, VitestManifestShapeError } from './errors.ts';

/** Read-only projection over the live manifest, scoped to the vitest
 *  surface's needs. The full envelope is reconstructed (`manifest`)
 *  for the test-side helpers that compare deep shapes; the convenience
 *  accessors cover the common case. */
export interface StackContext {
	/** Absolute path of the manifest file the projection came from. */
	readonly manifestPath: string;
	/** Reconstructed envelope — same shape downstream consumers had
	 *  pre-consolidation. */
	readonly manifest: ManifestEnvelope;
	/** Identity tuple shortcut. */
	readonly identity: ManifestEnvelope['identity'];
	/** Flat endpoint lookup — returns the URL string or `undefined`. */
	readonly endpoint: (name: string) => string | undefined;
	/** Display URL variant — falls back to `url` when `displayUrl` is
	 *  null (the routed-vs-direct distinction the router decides). */
	readonly displayEndpoint: (name: string) => string | undefined;
}

export interface LoadStackContextOptions {
	/** Starting directory for the walk-up. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Stack name override. Defaults to `process.env.DEVSTACK_STACK`
	 *  with a final fallback to `'main'`. */
	readonly stack?: string;
	/** Runtime root override (legacy `.devstack` directory). Defaults
	 *  to `process.env.DEVSTACK_RUNTIME_ROOT` /
	 *  `process.env.DEVSTACK_STATE_DIR` with a final fallback to
	 *  `'.devstack'`. */
	readonly runtimeRoot?: string;
	/** Explicit absolute manifest path. Bypasses the walk-up but is
	 *  still validated to exist. Lower precedence than the
	 *  `DEVSTACK_MANIFEST_PATH` env var. */
	readonly manifestPath?: string;
	/** Env bag for the resolver. Defaults to `process.env`. Tests pass
	 *  a fixture. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** When `true`, throw `VitestManifestNotFoundError` on miss instead
	 *  of returning `undefined`. */
	readonly required?: boolean;
}

const project = (ctx: RuntimeStackContext): StackContext => {
	const envelope: ManifestEnvelope = {
		identity: ctx.identity,
		manifestVersion: ctx.manifestVersion,
		services: ctx.services,
		// Reconstruct from the EndpointRegistry — the runtime projection
		// uses a class wrapper, but downstream vitest callers want the
		// flat record shape of the envelope.
		endpoints: Object.fromEntries(
			ctx.endpoints.all().map((e) => [
				e.name,
				{
					url: e.url,
					displayUrl: e.displayUrl,
					wireProtocol: e.wireProtocol,
					pluginKey: e.pluginKey as never,
					endpointKey: e.endpointKey as never,
				},
			]),
		) as ManifestEnvelope['endpoints'],
		extras: ctx.extras,
	};
	return {
		manifestPath: ctx.manifestPath,
		manifest: envelope,
		identity: envelope.identity,
		endpoint: (name) => ctx.endpoints.byName(name)?.url,
		displayEndpoint: (name) => {
			const e = ctx.endpoints.byName(name);
			if (e === undefined) return undefined;
			return e.displayUrl ?? e.url;
		},
	};
};

/**
 * Read the on-disk manifest, decode against the envelope schema, and
 * return a projection. Returns `undefined` on miss; pass
 * `{ required: true }` to throw `VitestManifestNotFoundError`.
 *
 * Precedence ladder (highest → lowest):
 *   1. `env.DEVSTACK_MANIFEST_PATH`
 *   2. `opts.manifestPath`
 *   3. walk-up from `opts.cwd` looking for
 *      `<runtimeRoot>/stacks/<stack>/manifest.json`
 */
export const loadStackContext = (opts: LoadStackContextOptions = {}): StackContext | undefined => {
	const env = opts.env ?? (process.env as Readonly<Record<string, string | undefined>>);
	const stack = opts.stack ?? env[VITEST_ENV_VARS.STACK] ?? 'main';
	const runtimeRoot =
		opts.runtimeRoot ??
		env[VITEST_ENV_VARS.RUNTIME_ROOT] ??
		env[VITEST_ENV_VARS.RUNTIME_ROOT_LEGACY] ??
		'.devstack';

	try {
		const ctx = readStackContextRuntime({
			...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
			stack,
			stateDir: runtimeRoot,
			env,
			...(opts.manifestPath !== undefined ? { manifestPath: opts.manifestPath } : {}),
		});
		return project(ctx);
	} catch (err) {
		if (err instanceof ManifestDiscoveryError) {
			if (opts.required === true) {
				throw new VitestManifestNotFoundError({
					message: `no devstack manifest found for stack '${stack}' under '${runtimeRoot}'`,
					searchedFrom: opts.cwd ?? process.cwd(),
					stack,
					stateDir: runtimeRoot,
					recovery: `run \`devstack up\` (or set DEVSTACK_MANIFEST_PATH to an existing file)`,
				});
			}
			return undefined;
		}
		if (err instanceof ManifestShapeError) {
			// The runtime tags both decode-failure and version-mismatch as
			// `phase: 'parse' | 'shape' | 'version'`. The vitest error
			// union exposes `parse` and `shape`; map `version` onto
			// `shape` with a recovery hint that names the version-bump
			// recipe.
			const phase: 'parse' | 'shape' = err.phase === 'parse' ? 'parse' : 'shape';
			throw new VitestManifestShapeError({
				phase,
				path: err.path,
				message: err.message,
				recovery:
					err.phase === 'parse'
						? `rm ${err.path} && devstack apply  # regenerate from the registries`
						: `rm -rf <runtimeRoot>/stacks/<stack>/manifest.json && devstack apply  # regenerate`,
				cause: err,
			});
		}
		throw err;
	}
};
