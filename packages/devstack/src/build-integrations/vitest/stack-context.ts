// Stack-context loader for the vitest integration — thin wrapper
// over `runtime/readStackContext`.
//
// The vitest preset is a passive reader of the supervisor's manifest.
// Discovery, decode, and version-gate live in `runtime/`; this module
// only:
//   - resolves the vitest-flavored env contract (`DEVSTACK_RUNTIME_ROOT`
//     plus `DEVSTACK_STATE_DIR` alias),
//   - exposes the manifest plus `endpoint(name)` / `displayEndpoint(name)`
//     convenience accessors test bodies use,
//   - re-shapes the canonical error tags into the vitest-flavored union
//     (`VitestManifestNotFoundError` / `VitestManifestShapeError`) so
//     caller `catchTag` flows stay stable.

import {
	manifestEnvelopeFromStackContext,
	ManifestDiscoveryError,
	ManifestShapeError,
	readStackContext as readStackContextRuntime,
	resolveBuiltInEndpointAlias,
	resolveDiscoveryEnv,
	type ManifestEnvelope,
	type StackContext as RuntimeStackContext,
} from '../runtime/index.ts';
import {
	VitestManifestNotFoundError,
	VitestManifestShapeError,
	VitestManifestVersionMismatchError,
} from './errors.ts';

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
	/** Stack name override. Defaults to `process.env.DEVSTACK_STACK`,
	 *  then the nearest package.json `name` above `cwd` (matching the
	 *  CLI's `resolveStackName` inference), with a final fallback to
	 *  `'main'`. */
	readonly stack?: string;
	/** Runtime root override. Defaults
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
	const envelope: ManifestEnvelope = manifestEnvelopeFromStackContext(ctx);
	// Alias-resolve the user-typed name BEFORE the registry lookup so
	// `endpoint('app')` resolves to whatever canonical key the substrate
	// emits (`'dev'` today). Mirrors the playwright surface
	// (`playwrightEndpointNameFor` in `playwright/stack-context.ts`) so
	// both build integrations share one alias table from
	// `runtime/conventional-routes.ts`. Without this, the `endpoint(name)`
	// accessor silently returns `undefined` for legit aliases the
	// playwright fixture happily accepts.
	const lookup = (nameOrAlias: string) =>
		ctx.endpoints.byName(resolveBuiltInEndpointAlias(nameOrAlias));
	return {
		manifestPath: ctx.manifestPath,
		manifest: envelope,
		identity: envelope.identity,
		endpoint: (name) => lookup(name)?.url,
		displayEndpoint: (name) => {
			const e = lookup(name);
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
	// `runtimeRoot` is the vitest-flavored name for the shared resolver's
	// `stateDir` rung; the ladder (option > DEVSTACK_RUNTIME_ROOT >
	// DEVSTACK_STATE_DIR > '.devstack') lives in `resolveDiscoveryEnv`.
	// The stack rung threads the loader's walk-up start so a bare app's
	// package-name-derived stack (the CLI's inference) is found without
	// DEVSTACK_STACK being set.
	const { stack, stateDir: runtimeRoot } = resolveDiscoveryEnv(env, {
		...(opts.stack !== undefined ? { stack: opts.stack } : {}),
		...(opts.runtimeRoot !== undefined ? { stateDir: opts.runtimeRoot } : {}),
		cwd: opts.cwd ?? process.cwd(),
	});

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
			// `env-missing` / `override-missing` surface regardless of
			// `required` — the user explicitly pointed at a file that
			// doesn't exist; silently returning `undefined` would
			// quietly fall back to cold-start defaults and hide the typo.
			// `required: false` only suppresses the walk-up-not-found
			// path (`phase: 'walk-up' | 'required-missing'`).
			if (err.phase === 'env-missing' || err.phase === 'override-missing') {
				throw new VitestManifestNotFoundError({
					message: err.message,
					searchedFrom: opts.cwd ?? process.cwd(),
					stack,
					stateDir: runtimeRoot,
					recovery: `run \`devstack up\` (or unset DEVSTACK_MANIFEST_PATH / pass an existing manifestPath)`,
				});
			}
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
			// The runtime tags decode-failure, structural drift, and
			// version-mismatch as `phase: 'parse' | 'shape' | 'version'`.
			// We surface them as two distinct error tags so callers can
			// distinguish malformed manifests from version mismatches.
			if (err.phase === 'version') {
				throw new VitestManifestVersionMismatchError({
					path: err.path,
					message: err.message,
					recovery: `run \`devstack up\` to regenerate the manifest.`,
					cause: err,
				});
			}
			throw new VitestManifestShapeError({
				phase: err.phase,
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
