// Unified path resolver.
//
// Architecture § "What's collapsed" — three path resolvers
// (state-store, service-paths, snapshot) consolidate to one. This is
// the L0 helper every disk-touching subsystem reaches for; nothing
// else in the runtime package may compose `<root>/<app>/<stack>/...`
// by hand.
//
// The resolver is a typed bundle: given an `Identity` and the
// `RuntimeRoot`, it returns the closed set of paths the substrate
// understands. Subsystems that need a sub-path inside one of those
// (e.g. cache namespace + chain + content-hash) compose ON TOP of the
// bundle's `cacheDir`, but they NEVER reach for `path.join(root, app,
// stack)` themselves.

import { Context, Effect, Layer, Path } from 'effect';

import type { Identity } from '../identity.ts';

/**
 * Runtime root — the on-disk base under which every stack's state
 * lives. Defaults to `~/.devstack`, but is injectable so tests pin
 * to a tempdir and parallel-stack tests pin to per-test prefixes.
 *
 * Held as a tagged service so the rest of the substrate can request
 * it without threading the string through every signature.
 */
export interface RuntimeRootShape {
	readonly root: string;
}

export class RuntimeRoot extends Context.Service<RuntimeRoot, RuntimeRootShape>()(
	'@devstack-rewrite/substrate/RuntimeRoot',
) {}

/** Build a `RuntimeRoot` layer pinned to a literal path. */
export const layerRuntimeRoot = (root: string): Layer.Layer<RuntimeRoot> =>
	Layer.succeed(RuntimeRoot)({ root });

/**
 * Identity-bound. Same shape as `substrate/identity.ts`'s `Identity`,
 * but lifted into a Context service so path resolution can yield it
 * without taking it as a function argument.
 *
 * Boot wires this once (Identity is validated up front); the
 * resolver and every consumer reads from this single source.
 */
export class IdentityContext extends Context.Service<IdentityContext, Identity>()(
	'@devstack-rewrite/substrate/Identity',
) {}

export const layerIdentity = (identity: Identity): Layer.Layer<IdentityContext> =>
	Layer.succeed(IdentityContext)(identity);

/**
 * Closed bundle the resolver returns. Three groups of paths:
 *
 *   - `stackRoot` and the three cross-process artifacts (lock,
 *     roster, snapshot reservation) live directly under the stack
 *     directory. Cross-process safety lives here.
 *   - `stateFile` is the per-stack state-store JSON. ONE file per
 *     stack — schema-validated on read.
 *   - `cacheDir` is the parent directory; the cache subsystem
 *     composes `<cacheDir>/<namespace>/<chainId>/<contentHash>.json`
 *     via a helper on this resolver. Subsystems do NOT reach into
 *     `cacheDir` with their own `path.join` calls.
 */
export interface StackPaths {
	readonly stackRoot: string;
	readonly stateFile: string;
	readonly stateLockHint: string;
	readonly cacheDir: string;
	readonly snapshotDir: string;
	readonly stackLockFile: string;
	readonly rosterFile: string;
	readonly snapshotReservationFile: string;
	/**
	 * Helper that composes the cache entry path from cache-key
	 * components. The substrate folds the components together here so
	 * that nothing else in the runtime tree builds cache paths.
	 */
	readonly cacheEntry: (
		namespace: string,
		chain: string,
		contentHash: string,
	) => { readonly dir: string; readonly file: string };
	/** Helper that returns the cache namespace directory for a given
	 *  namespace + chain — for `readDirectory` enumeration. */
	readonly cacheChainDir: (namespace: string, chain: string) => string;
	/** Helper that returns the cache namespace directory (across all
	 *  chains) — for namespace-scoped enumeration. */
	readonly cacheNamespaceDir: (namespace: string) => string;
}

/**
 * The path resolver service. Yields `StackPaths` once per stack —
 * `Effect.cached`-friendly since `Identity` + `RuntimeRoot` are
 * boot-immutable.
 */
export class StackPathsService extends Context.Service<StackPathsService, StackPaths>()(
	'@devstack-rewrite/substrate/StackPaths',
) {}

/**
 * Layer that materializes the resolver from `RuntimeRoot` +
 * `IdentityContext` + the Effect `Path` service. The cache helper
 * uses `Path.join` so OS-correct separators round-trip on Windows
 * (defense-in-depth — devstack is posix-only in practice but the
 * cost of `Path.join` over template strings is zero).
 */
export const layerStackPaths: Layer.Layer<
	StackPathsService,
	never,
	RuntimeRoot | IdentityContext | Path.Path
> = Layer.effect(
	StackPathsService,
	Effect.gen(function* () {
		const { root } = yield* RuntimeRoot;
		const identity = yield* IdentityContext;
		const path = yield* Path.Path;
		const stackRoot = path.join(root, identity.app, identity.stack);
		const cacheDir = path.join(stackRoot, 'cache');
		const cacheNamespaceDir = (namespace: string): string => path.join(cacheDir, namespace);
		const cacheChainDir = (namespace: string, chain: string): string =>
			path.join(cacheNamespaceDir(namespace), chain);
		const cacheEntry = (
			namespace: string,
			chain: string,
			contentHash: string,
		): { readonly dir: string; readonly file: string } => {
			const dir = cacheChainDir(namespace, chain);
			return { dir, file: path.join(dir, `${contentHash}.json`) };
		};
		return StackPathsService.of({
			stackRoot,
			stateFile: path.join(stackRoot, 'state.json'),
			stateLockHint: path.join(stackRoot, 'state.json.lock'),
			cacheDir,
			snapshotDir: path.join(stackRoot, 'snapshots'),
			stackLockFile: path.join(stackRoot, 'stack.lock'),
			rosterFile: path.join(stackRoot, 'roster.json'),
			snapshotReservationFile: path.join(stackRoot, 'snapshot.reservation'),
			cacheEntry,
			cacheChainDir,
			cacheNamespaceDir,
		});
	}),
);
