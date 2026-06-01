// Codegen output-path layout.
//
// Distilled-doc § "All outputs land under a single user-chosen
// directory (default `./src/generated/`)" + §"Stable output paths".
// One file owns the layout so emitters never assemble paths by hand.
//
// Default root is `<appRoot>/src/generated/`. Tests and parallel
// stacks pin a per-test root; the substrate's `RuntimeRoot` is for
// engine-private state (~/.devstack/...), NOT for codegen output.
// Codegen output lives in the USER's source tree.

import { Context, Effect, Layer, Path } from 'effect';

import { CodegenPathConflict } from './errors.ts';

/** Guard plugin-authored `CodegenableDecl.outputPath` against `..`
 *  traversal and absolute paths. Fails with a typed
 *  `CodegenPathConflict({kind:'non-relative'})` — defense-in-depth
 *  for the file-layout invariants. Called once inside `buildAt` so
 *  both the root bundle and any `withRoot`-rebased view enforce the
 *  same `..`-rejecting `resolve` discipline.
 *
 *  POSIX-only: devstack runs on POSIX filesystems (substrate paths
 *  are POSIX-shaped throughout), so this check intentionally inspects
 *  only `/`-rooted absolutes and the `..` substring. A Windows-style
 *  `'foo/bar\\..\\baz'` would slip past — that's accepted because
 *  devstack never executes on a Windows runtime.
 *
 *  STYLE_GUIDE §2 rule 5 — orchestrator failures are typed. */
export const assertRelativeCodegenOutputPath = (
	outputPath: string,
): Effect.Effect<void, CodegenPathConflict> =>
	outputPath.includes('..') || outputPath.startsWith('/')
		? Effect.fail(
				new CodegenPathConflict({
					kind: 'non-relative',
					outputPath,
					emitters: [],
				}),
			)
		: Effect.void;

/**
 * Codegen output root — the directory codegen owns and overwrites.
 * Pinned at boot time from the user's `defineDevstack` options
 * (default `./src/generated/` resolved against the app's cwd).
 *
 * Held as a service so emitters can yield it without a function
 * argument; mirrors the substrate's `RuntimeRoot` pattern.
 */
export interface CodegenRootShape {
	/** Absolute path to the output directory. The orchestrator
	 *  manages it; the user never writes here. */
	readonly outputDir: string;
	/** Optional per-stack subdirectory under `outputDir`. When set,
	 *  parallel stacks emit into sibling directories under the same
	 *  output root (distilled-doc §"per-stack subdirectory"). */
	readonly stackSubdir: string | null;
	/** Absolute path to the dev-only + secret `generated-extras` tree
	 *  (`.devstack/stacks/<stack>/generated-extras`). Decls / aggregates
	 *  with `outputLocation: 'generated-extras'` emit here. Outside the
	 *  staging-and-swap tree of `outputDir` — extras are gitignored and
	 *  written in place (no atomic swap), so warm restarts never churn
	 *  the runtime tree's mtimes. */
	readonly extrasDir: string;
}

export class CodegenRoot extends Context.Service<CodegenRoot, CodegenRootShape>()(
	'@devstack/orchestrator/CodegenRoot',
) {}

/** Build a `CodegenRoot` layer pinned to a literal path. */
export const layerCodegenRoot = (root: CodegenRootShape): Layer.Layer<CodegenRoot> =>
	Layer.succeed(CodegenRoot)(root);

/** Closed bundle the resolver returns. Mirrors substrate `StackPaths`. */
export interface CodegenPaths {
	/** The directory the orchestrator emits into (after applying
	 *  per-stack subdirectory if configured). The watcher MUST
	 *  exclude this directory. */
	readonly outputDir: string;
	/** Path to the `.gitignore` inside `outputDir`. Written every
	 *  emit (the dir is gitignored). */
	readonly gitignoreFile: string;
	/** Subtree where Move-to-TS bindings land. */
	readonly bindingsDir: string;
	/** Per-process lock file gating `runEmitCycle`. Sibling to
	 *  `outputDir` so concurrent invocations (e.g. CLI direct-callers
	 *  racing the supervisor) serialize cleanly without blocking the
	 *  short-section substrate `stack.lock`. Codegen cycles can be
	 *  file-system heavy (multi-emitter, Move-bindings compilation);
	 *  the substrate lock is reserved for short sections per the
	 *  cross-process safety protocol. */
	readonly codegenLockFile: string;
	/** The dev-only + secret `generated-extras` tree. Decls /
	 *  aggregates with `outputLocation: 'generated-extras'` resolve
	 *  against this. Preserved verbatim across `withRoot` — the extras
	 *  tree lives OUTSIDE the staging-and-swap of `outputDir`, so the
	 *  staging rebase must still name the real extras dir. */
	readonly extrasDir: string;
	/** Helper: resolve an emitter's `outputPath` (e.g. `config.ts`)
	 *  against the output root. Fails with `CodegenPathConflict({kind:
	 *  'non-relative'})` if the supplied path escapes the root. */
	readonly resolve: (outputPath: string) => Effect.Effect<string, CodegenPathConflict>;
	/** Helper: resolve an emitter's `outputPath` against the
	 *  `generated-extras` tree (`extrasDir`). Same `..`-rejecting
	 *  discipline as `resolve`. */
	readonly resolveExtras: (outputPath: string) => Effect.Effect<string, CodegenPathConflict>;
	/** Helper: resolve a per-package bindings subtree path. */
	readonly resolveBindingsPackage: (packageName: string) => string;
	/** Data-driven rebase: re-root the entire bundle at `newRoot`.
	 *  Preserves the layout (bindings under `<root>/bindings`, gitignore
	 *  at `<root>/.gitignore`) and the `..`-rejecting `resolve`
	 *  discipline; only the prefix changes. Used by the stage-and-swap
	 *  build to redirect the emit pipeline at the staging directory
	 *  WITHOUT string-surgery in the caller.
	 *
	 *  Note: `codegenLockFile` is preserved verbatim — the lock is
	 *  acquired ONCE outside the staging build, so the rebased view
	 *  must still name the real lock path. */
	readonly withRoot: (newRoot: string) => CodegenPaths;
}

export class CodegenPathsService extends Context.Service<CodegenPathsService, CodegenPaths>()(
	'@devstack/orchestrator/CodegenPaths',
) {}

/**
 * Materialize the resolver from `CodegenRoot` + Effect's `Path`
 * service. Stack subdir, if present, is appended:
 *   `<outputDir>` or `<outputDir>/<stackSubdir>`.
 */
export const layerCodegenPaths: Layer.Layer<CodegenPathsService, never, CodegenRoot | Path.Path> =
	Layer.effect(
		CodegenPathsService,
		Effect.gen(function* () {
			const root = yield* CodegenRoot;
			const path = yield* Path.Path;
			const outputDir = root.stackSubdir
				? path.join(root.outputDir, root.stackSubdir)
				: root.outputDir;
			// Sibling of `outputDir` (NOT inside it) so the stage-and-swap
			// rename never sees the lock file as part of the output tree.
			// Captured once at boot — `withRoot` re-roots the rest of the
			// bundle but preserves the original lock path so the rebased
			// view names the real cross-process lock (the lock is acquired
			// ONCE outside the staging build).
			const codegenLockFile = `${outputDir}.codegen.lock`;
			// Captured once at boot. Preserved verbatim through `withRoot`
			// (the extras tree is OUTSIDE the staging swap of `outputDir`,
			// so the rebased view must keep naming the real extras dir).
			const extrasDir = root.extrasDir;
			const resolveExtras = (
				outputPath: string,
			): Effect.Effect<string, CodegenPathConflict> =>
				Effect.gen(function* () {
					yield* assertRelativeCodegenOutputPath(outputPath);
					return path.join(extrasDir, outputPath);
				});
			const buildAt = (atRoot: string): CodegenPaths => {
				const bindingsDir = path.join(atRoot, 'bindings');
				const resolve = (outputPath: string): Effect.Effect<string, CodegenPathConflict> =>
					Effect.gen(function* () {
						yield* assertRelativeCodegenOutputPath(outputPath);
						return path.join(atRoot, outputPath);
					});
				const resolveBindingsPackage = (packageName: string): string =>
					path.join(bindingsDir, packageName);
				const bundle: CodegenPaths = {
					outputDir: atRoot,
					gitignoreFile: path.join(atRoot, '.gitignore'),
					bindingsDir,
					codegenLockFile,
					extrasDir,
					resolve,
					resolveExtras,
					resolveBindingsPackage,
					withRoot: (newRoot: string) => buildAt(newRoot),
				};
				return bundle;
			};
			return CodegenPathsService.of(buildAt(outputDir));
		}),
	);
