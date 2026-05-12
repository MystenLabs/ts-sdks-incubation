import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Dep, Provides } from '../engine/types.js';
import { dep } from '../factories/dep.js';
import { define } from '../factories/define.js';
import { sui } from '../plugins/sui.js';
import type { Package } from '../shapes/index.js';

export interface PublishedPackage {
	packageId: string;
	/** Optional secondary objects returned by the publish — TreasuryCap,
	 * UpgradeCap, AdminCap, etc. The caller's `publish` callback decides
	 * which objects to surface; they round-trip through SnapshotRecord
	 * verbatim. */
	objects?: Record<string, string>;
}

export interface PublishMoveContext<TSigner> {
	sourcePath: string;
	signer: TSigner;
	rpcUrl: string;
	/** Per-cycle FNV digest of the Move source tree. Helpful when the
	 * caller wants to write the digest into the published transaction's
	 * description, or to short-circuit if a remote registry already has
	 * a build keyed on this digest. */
	sourceHash: string;
}

export interface PublishMoveOptions<TSigner> {
	/** Logical package name used in `represents.packages` and the engine
	 * node name (`publish.<name>`). Must be unique per stack. */
	name: string;
	/** Path to the Move package. Either a literal string (relative to
	 * `env.appDir` or absolute) for first-party Move packages in the
	 * app's tree, or a `Dep<void, string>` chained off a `gitFetch(...)`
	 * (or any other producer that exposes a path) for upstream Move
	 * packages vendored into the dev stack. With a Dep, the path
	 * resolves at start-time and the engine cascade re-fires publish on
	 * source changes. */
	path: string | Dep<void, string>;
	/** Dep returning the publisher signer — typically
	 * `accounts.get('signer', { name: 'publisher' })`.
	 * `Dep<any, …>` here so callers can pass either a no-data Dep
	 * (`acc.get('signer')`) or a parameterized one (`pool.get('signer',
	 * { name })`); TData is contravariant, so a tighter bound rejects
	 * one of the two shapes. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	signer: Dep<any, TSigner>;
	/** SDK-shaped chain operation. Called once per dirty cycle. The helper
	 * skips re-publish when source hash + signer + RPC URL haven't changed
	 * (input-hash short-circuit). */
	publish: (ctx: PublishMoveContext<TSigner>) => Promise<PublishedPackage>;
	/** Override the runsAs lock key. Default `'publisher'` so two
	 * publishMove actions sharing the publisher signer serialize against
	 * each other (avoids gas-object equivocation). */
	runsAs?: string;
	/** MVR placeholder used by the `bindings` plugin in emitted
	 * `tx.moveCall({ package: '<placeholder>', … })` calls. Defaults to
	 * `'@local/<name>'`. Override only when an app needs a specific
	 * placeholder string (e.g. cross-app sharing); the default works for
	 * 99% of cases. */
	mvrPlaceholder?: string;
}

export interface PublishState extends PublishedPackage {
	sourceHash: string;
	/** Absolute path to the Move source. Captured in start() so the
	 * `package` Dep can surface it without re-resolving against env. */
	path: string;
	mvrPlaceholder: string;
}

// Default `provides` values are placeholders — the real recipes are
// constructed inside the factory below where `name` + `mvrPlaceholder`
// are known.
const provides = {
	package: dep((s: PublishState): Package => {
		const pkg: Package = {
			name: '',
			packageId: s.packageId,
			mvrPlaceholder: s.mvrPlaceholder,
			path: s.path,
		};
		if (s.objects !== undefined && Object.keys(s.objects).length > 0) {
			pkg.captured = s.objects;
		}
		return pkg;
	}),
	full: dep((s: PublishState) => s),
} satisfies Provides<PublishState>;

// `publishMove` encodes the "publish a Move package once per source
// change" pattern. The helper:
//
//   - Auto-deps on `sui.get('rpc')` (ambient — pulls sui's instance into
//     the graph transitively).
//   - Computes a content hash of the Move source tree on each cycle and
//     folds it into the input hash, so source edits trigger re-publish.
//   - Defaults `runsAs: 'publisher'` so all publishMove actions sharing
//     a single publisher signer serialize and don't fight for the gas
//     object.
//   - Projects the `packageId` onto a `Package`-shape Dep + represents
//     it under the standard `packages` category, so manifest / bindings / TUI see it.
//
// The chain work itself is the caller's `publish` callback. Devstack-next
// stays SDK-agnostic.
//
//   const token = publishMove({
//     name: 'token',
//     path: 'move/token',
//     signer: accounts.get('signer', { name: 'publisher' }),
//     publish: async ({ sourcePath, signer, rpcUrl }) => {
//       const result = await mySdk.publishPackage(sourcePath, signer, rpcUrl);
//       return { packageId: result.packageId, objects: { treasuryCap: result.treasury } };
//     },
//   });
//
//   token.get('package')   // Dep<void, Package>
//   token.get('full')      // Dep<void, PublishState>
export function publishMove<TSigner>(opts: PublishMoveOptions<TSigner>) {
	if (!opts.name) throw new Error('publishMove: `name` is required');
	if (!opts.path) throw new Error(`publishMove("${opts.name}"): \`path\` is required`);
	if (typeof opts.publish !== 'function') {
		throw new Error(`publishMove("${opts.name}"): \`publish\` callback is required`);
	}

	const pathIsDep = isPathDep(opts.path);
	const deps: Record<string, Dep<unknown, unknown>> = {
		signer: opts.signer as Dep<unknown, unknown>,
		rpc: sui.get('rpc') as unknown as Dep<unknown, unknown>,
	};
	if (pathIsDep) {
		deps._path = opts.path as Dep<unknown, unknown>;
	}
	const provName = opts.name;
	// MVR-style placeholder. Names accept lowercase + digits + hyphens
	// (no underscores) per the Move Registry spec; snake_case Move
	// package names get bridged automatically. Callers can still
	// override via `mvrPlaceholder:` for custom registries.
	const mvrPlaceholder = opts.mvrPlaceholder ?? `@local/${opts.name.replace(/_/g, '-')}`;

	// Customize the package recipe to inject the user's name + the
	// resolved placeholder (the schema can't know either at module load).
	const namedProvides = {
		...provides,
		package: dep((s: PublishState): Package => {
			const pkg: Package = {
				name: provName,
				packageId: s.packageId,
				mvrPlaceholder: s.mvrPlaceholder,
				path: s.path,
			};
			if (s.objects !== undefined && Object.keys(s.objects).length > 0) {
				pkg.captured = s.objects;
			}
			return pkg;
		}),
	} satisfies Provides<PublishState>;

	return define<PublishState, typeof namedProvides, typeof deps>({
		name: `publish.${opts.name}`,
		runsAs: opts.runsAs ?? 'publisher',
		deps,
		provides: namedProvides,
		inputs: ({ env, deps: depsResolved }) => {
			const r = depsResolved as { rpc: { url: string }; _path?: string };
			const abs = resolveSourcePath(opts.path, env.appDir, r._path);
			return {
				name: opts.name,
				rpcUrl: r.rpc.url,
				// Empty string when the path Dep hasn't resolved yet — engine
				// re-fires us once the upstream path lands.
				sourceHash: abs === undefined ? '' : hashMoveTree(abs),
				mvrPlaceholder,
			};
		},
		run: async ({ env, deps: depsResolved, watch }) => {
			const r = depsResolved as {
				signer: TSigner;
				rpc: { url: string };
				_path?: string;
			};
			const abs = resolveSourcePath(opts.path, env.appDir, r._path);
			if (abs === undefined) {
				throw new Error(
					`publishMove("${opts.name}"): path Dep resolved to empty/undefined`,
				);
			}
			if (!existsSync(abs)) {
				throw new Error(`publishMove("${opts.name}"): source path does not exist: ${abs}`);
			}
			// Register the source dir for fs-watching. The supervisor uses
			// engine.getWatchPaths(name) to drive `up` re-cycles when a
			// .move file changes. inputs() includes hashMoveTree so the
			// re-cycle picks up the edit and re-publishes.
			watch(abs);
			const sourceHash = hashMoveTree(abs);
			const result = await opts.publish({
				sourcePath: abs,
				signer: r.signer,
				rpcUrl: r.rpc.url,
				sourceHash,
			});
			const state: PublishState = {
				packageId: result.packageId,
				sourceHash,
				path: abs,
				mvrPlaceholder,
			};
			if (result.objects !== undefined) state.objects = result.objects;
			return state;
		},
		represents: {
			packages: (s: PublishState): Package[] => {
				const pkg: Package = {
					name: opts.name,
					packageId: s.packageId,
					mvrPlaceholder: s.mvrPlaceholder,
					path: s.path,
				};
				if (s.objects !== undefined && Object.keys(s.objects).length > 0) {
					pkg.captured = s.objects;
				}
				return [pkg];
			},
		},
	});
}

function resolvePath(appDir: string, path: string): string {
	if (path.startsWith('/')) return path;
	return join(appDir, path);
}

function isPathDep(path: string | Dep<void, string>): path is Dep<void, string> {
	if (typeof path !== 'object' || path === null) return false;
	return '__producer' in path || '__pluginId' in path;
}

// Resolve the path option to an absolute fs path.
//   - Literal string: relative to env.appDir.
//   - Dep: read the resolved value from the deps slot.
function resolveSourcePath(
	pathOpt: string | Dep<void, string>,
	appDir: string,
	resolvedDepValue: string | undefined,
): string | undefined {
	if (typeof pathOpt === 'string') return resolvePath(appDir, pathOpt);
	if (resolvedDepValue === undefined || resolvedDepValue.length === 0) return undefined;
	return resolvedDepValue.startsWith('/') ? resolvedDepValue : join(appDir, resolvedDepValue);
}

// Hash the Move source tree under `root`. Walks recursively, picks up
// `*.move` and `Move.toml` files (skips `build/`, the local artifact
// directory). Order-independent — file paths are sorted before hashing.
export function hashMoveTree(root: string): string {
	if (!existsSync(root)) return '';
	const files = listMoveSources(root);
	files.sort();
	const h = createHash('sha256');
	for (const file of files) {
		h.update(file);
		h.update('\0');
		try {
			h.update(readFileSync(file));
		} catch {
			// ignore read errors — produces a hash that flips next cycle
			// once the file is readable, which is the correct behavior.
		}
	}
	return h.digest('hex').slice(0, 16);
}

function listMoveSources(root: string): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'build' || entry.name === 'node_modules') continue;
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name === 'Move.toml' || entry.name.endsWith('.move')) {
				try {
					if (statSync(full).isFile()) out.push(full);
				} catch {
					// skip
				}
			}
		}
	}
	return out;
}
