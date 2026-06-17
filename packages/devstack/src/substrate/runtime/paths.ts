// Unified path resolver.
//
// Architecture § "What's collapsed" — three path resolvers
// (service-paths, snapshot) consolidate to one. This is
// the L0 helper every disk-touching subsystem reaches for; nothing
// else in the runtime package may compose `<root>/stacks/<stack>/...`
// by hand.
//
// The resolver is a typed bundle: given an `Identity` and the
// `RuntimeRoot`, it returns the closed set of paths the substrate
// understands. Subsystems that need a sub-path inside one of those
// (e.g. cache namespace + chainId + content-hash) compose ON TOP of the
// bundle's `cacheDir`, but they NEVER reach for
// `path.join(root, 'stacks', stack)` themselves.

import { Context, Effect, Layer, Path } from 'effect';

import type { Identity } from '../identity.ts';

/** The single per-stack directory segment. Every per-stack subtree lives
 *  under `<root>/stacks/<stack>/...`; this is the one place that literal
 *  is authored. */
const STACKS_SEGMENT = 'stacks';

/**
 * The ONE pure composer for the `<root>/stacks/<stack>/...` path shape.
 *
 * NO base is baked in — the caller supplies BOTH the `join` strategy and
 * the `root`, so the same shape is authored once and reused with different
 * bases:
 *
 *   - the substrate roots at `RuntimeRoot` (`~/.devstack` by default):
 *     `stackSubpath(Path.join, runtimeRoot, identity.stack, 'cache')`.
 *   - codegen roots at the app source tree:
 *     `stackSubpath(node.join, join(appRoot, '.devstack'), stack, 'generated')`.
 *
 * Threading `join` (rather than importing one) keeps this purely string
 * algebra: the substrate passes Effect's `Path` service `join` (Windows-
 * correct separators, defense-in-depth) and codegen passes `node:path`'s
 * `join` — neither implementation is baked in here.
 */
export const stackSubpath = (
	join: (...segments: ReadonlyArray<string>) => string,
	root: string,
	stack: string,
	...rest: ReadonlyArray<string>
): string => join(root, STACKS_SEGMENT, stack, ...rest);

/**
 * Runtime root — the on-disk base under which every stack's state
 * lives. Defaults to `.devstack`, but is injectable so tests pin to
 * a tempdir and parallel-stack tests pin to per-test prefixes.
 *
 * Held as a tagged service so the rest of the substrate can request
 * it without threading the string through every signature.
 */
export interface RuntimeRootShape {
	readonly root: string;
}

export class RuntimeRoot extends Context.Service<RuntimeRoot, RuntimeRootShape>()(
	'@devstack/substrate/RuntimeRoot',
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
	'@devstack/substrate/Identity',
) {}

export const layerIdentity = (identity: Identity): Layer.Layer<IdentityContext> =>
	Layer.succeed(IdentityContext)(identity);

/**
 * Closed bundle the resolver returns. Three groups of paths:
 *
 *   - `stackRoot` and the cross-process artifacts (lock, roster,
 *     command channel) live directly under the stack directory.
 *     Cross-process safety lives here.
 *   - `cacheDir` is the parent directory; the cache subsystem
 *     composes `<cacheDir>/<namespace>/<chainId>/<contentHash>.json`
 *     via a helper on this resolver. Subsystems do NOT reach into
 *     `cacheDir` with their own `path.join` calls.
 */
export interface StackPaths {
	readonly stackRoot: string;
	readonly cacheDir: string;
	readonly snapshotDir: string;
	readonly stackLockFile: string;
	readonly rosterFile: string;
	/**
	 * Helper that composes the cache entry path from cache-key
	 * components. The substrate folds the components together here so
	 * that nothing else in the runtime tree builds cache paths.
	 */
	readonly cacheEntry: (
		namespace: string,
		chainId: string,
		contentHash: string,
	) => { readonly dir: string; readonly file: string };
	/** Helper that returns the cache namespace directory for a given
	 *  namespace + chainId — for `readDirectory` enumeration. */
	readonly cacheChainDir: (namespace: string, chainId: string) => string;
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
	'@devstack/substrate/StackPaths',
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
		const stackRoot = stackSubpath(path.join, root, identity.stack);
		const cacheDir = path.join(stackRoot, 'cache');
		const cacheNamespaceDir = (namespace: string): string => path.join(cacheDir, namespace);
		const cacheChainDir = (namespace: string, chainId: string): string =>
			path.join(cacheNamespaceDir(namespace), chainId);
		const cacheEntry = (
			namespace: string,
			chainId: string,
			contentHash: string,
		): { readonly dir: string; readonly file: string } => {
			const dir = cacheChainDir(namespace, chainId);
			return { dir, file: path.join(dir, `${contentHash}.json`) };
		};
		return StackPathsService.of({
			stackRoot,
			cacheDir,
			snapshotDir: path.join(stackRoot, 'snapshots'),
			stackLockFile: path.join(stackRoot, 'stack.lock'),
			rosterFile: path.join(stackRoot, 'roster.json'),
			cacheEntry,
			cacheChainDir,
			cacheNamespaceDir,
		});
	}),
);
