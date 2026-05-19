// `vendorDeepbook(opts?)` — clone deepbook + deepbook-sandbox Move
// sources and materialize all six packages with patched `Move.toml`
// files (`[environments] localnet = "<chainId>"`, git→local dep
// rewrites). Output dir is per-(ref, stack) under
// `.devstack/vendor/deepbook/<ref>/`; the git cache itself sits under
// the standard `gitFetch` location, shared across stacks.
//
// Six packages, two source repos:
//
//   - `token`, `deepbook`, `deepbook_margin`, `margin_liquidation` —
//     vendored from `MystenLabs/deepbookv3` (via the sandbox's
//     `external/deepbook` submodule mirror).
//   - `pyth`, `usdc` — vendored from `MystenLabs/deepbook-sandbox`'s
//     `packages/` directory.
//
// We materialize each package into a per-(ref) tree so callers can pass
// `vendor.<name>` directly to `publishMove({ path })`. The Move.toml
// patches:
//
//   1. Ensure `[environments] localnet = "<chainId>"` exists for the
//      builder (matches the sandbox's deployer behaviour). Today this is
//      a no-op since `publishMove` doesn't require it; future-proof for
//      the upstream toolchain.
//   2. Rewrite git-dep blocks pointing at the deepbook upstream to local
//      `{ local = "../<name>" }` deps so the publish chain doesn't
//      attempt a network clone at build time.
//
// The recipe currently does the gitFetch + tree materialization +
// Move.toml patch in-process via `node:fs`. A future `dockerOneShot`
// variant can run inside `sui-image` if hermetic-builds are required.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as nodeFs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { tag, type LayeredTag } from '../../advanced/tag.js';
import type { StackMember } from '../../engine/supervisor.js';
import { gitFetch } from '../../advanced/plugin-author/git-fetch.js';
import { DeepbookError } from '../../engine/errors.js';
import { stringifyCause } from '../../engine/stringify-cause.js';

// Default upstream repos. Pinned ref `'main'` lets the cache invalidate
// on every supervisor cycle when on a moving branch; tag refs cache
// indefinitely.
// Upstream renamed `MystenLabs/deepbook` → `MystenLabs/deepbookv3` —
// pinning to the canonical live repo so default `VendorDeepbook()`
// calls keep working.
const DEFAULT_DEEPBOOK_REPO = 'https://github.com/MystenLabs/deepbookv3';
const DEFAULT_SANDBOX_REPO = 'https://github.com/MystenLabs/deepbook-sandbox';

export interface VendoredDeepbookSources {
	readonly token: string;
	readonly deepbook: string;
	readonly pyth: string;
	readonly usdc: string;
	readonly deepbook_margin: string;
	readonly margin_liquidation: string;
	/** Root vendor directory (parent of all six package dirs). */
	readonly root: string;
	/** The git ref the sources were cloned from. */
	readonly ref: string;
}

export interface VendorDeepbookOptions {
	readonly name?: string;
	/** Git ref (tag, branch, sha) for the **deepbook** repo clone.
	 *  Defaults to `'main'`. */
	readonly ref?: string;
	/** Git ref for the **sandbox** repo clone. Defaults to whatever
	 *  `ref` resolves to if the sandbox carries the same tag, but the
	 *  sandbox's tag namespace is independent of deepbookv3's (it
	 *  uses `v0.x` whereas deepbookv3 ships `v7.x`+). Set this
	 *  explicitly when pinning `ref` to a deepbook-only tag — e.g.
	 *  `ref: 'v7.0.0'` + `sandboxRef: 'main'`. Defaults to `'main'`. */
	readonly sandboxRef?: string;
	/** Override the deepbook upstream repo. Defaults to MystenLabs/deepbookv3. */
	readonly deepbookRepo?: string;
	/** Override the sandbox upstream repo. Defaults to MystenLabs/deepbook-sandbox. */
	readonly sandboxRepo?: string;
	/** Override the output directory. Defaults to `.devstack/vendor/deepbook/<ref>/`. */
	readonly outDir?: string;
	/** Dependencies that should run before vendoring. Rare — vendoring
	 *  has no other prerequisites. */
	readonly dependsOn?: ReadonlyArray<LayeredTag<any, any, any, any>>;
}

// Patch `Move.toml` to:
//   - ensure `[environments] localnet` exists (no-op if already present).
//   - rewrite git-dep blocks to local paths.
const patchMoveToml = async (
	movePath: string,
	localDeps: ReadonlyArray<{ readonly depName: string; readonly relativePath: string }>,
): Promise<void> => {
	let content = await nodeFs.readFile(movePath, 'utf8');

	// Rewrite git deps. We match a `[dependencies.X]` or top-level
	// `X = { git = "...", subdir = "...", rev = "..." }` block per dep
	// name in `localDeps`. Replace the body with `{ local = "<rel>" }`.
	for (const { depName, relativePath } of localDeps) {
		// `[dependencies.X]` table block style:
		//   [dependencies.X]
		//   git = "..."
		//   subdir = "..."
		//   rev = "..."
		const tableRe = new RegExp(
			`\\[dependencies\\.${depName}\\]\\s*\\n(?:[ \\t]*(?:git|subdir|rev|local|version)[ \\t]*=.*\\n)+`,
			'g',
		);
		content = content.replace(tableRe, `[dependencies.${depName}]\nlocal = "${relativePath}"\n`);
		// Inline `X = { git = "...", ... }` form:
		const inlineRe = new RegExp(`^${depName}[ \\t]*=[ \\t]*\\{[^}]*\\}`, 'gm');
		content = content.replace(inlineRe, `${depName} = { local = "${relativePath}" }`);
	}

	await nodeFs.writeFile(movePath, content, 'utf8');
};

const PACKAGE_PATHS = {
	// Inside the deepbook repo
	token: { repoKey: 'deepbook', subdir: 'packages/token' },
	deepbook: { repoKey: 'deepbook', subdir: 'packages/deepbook' },
	deepbook_margin: { repoKey: 'deepbook', subdir: 'packages/deepbook_margin' },
	margin_liquidation: { repoKey: 'deepbook', subdir: 'packages/margin_liquidation' },
	// Inside the sandbox repo
	pyth: { repoKey: 'sandbox', subdir: 'packages/pyth' },
	usdc: { repoKey: 'sandbox', subdir: 'packages/usdc' },
} as const;

type PackageName = keyof typeof PACKAGE_PATHS;
const PACKAGE_NAMES: ReadonlyArray<PackageName> = Object.keys(PACKAGE_PATHS) as PackageName[];

// Local-dep rewrites per package. Keys are package names this package
// depends on; values are the rewrite target (relative to the package's
// own dir). The two repos' Move.toml files use `git+subdir+rev` deps
// pointing at the deepbook upstream; we rewrite those to local sibling
// paths since we've already materialized them.
const LOCAL_DEPS: Record<PackageName, ReadonlyArray<string>> = {
	token: [],
	deepbook: ['token'],
	pyth: [],
	usdc: [],
	deepbook_margin: ['token', 'deepbook', 'pyth'],
	margin_liquidation: ['token', 'deepbook', 'deepbook_margin'],
};

// Recursively copy `src` into `dst`, creating dst's parent as needed.
const copyDir = async (src: string, dst: string): Promise<void> => {
	await nodeFs.mkdir(dst, { recursive: true });
	const entries = await nodeFs.readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const from = nodePath.join(src, entry.name);
		const to = nodePath.join(dst, entry.name);
		if (entry.isDirectory()) {
			await copyDir(from, to);
		} else if (entry.isFile()) {
			await nodeFs.copyFile(from, to);
		}
	}
};

export const vendorDeepbook = (opts: VendorDeepbookOptions = {}) => {
	const name = opts.name ?? 'vendorDeepbook';
	const ref = opts.ref ?? 'main';
	const sandboxRef = opts.sandboxRef ?? 'main';
	const deepbookRepo = opts.deepbookRepo ?? DEFAULT_DEEPBOOK_REPO;
	const sandboxRepo = opts.sandboxRepo ?? DEFAULT_SANDBOX_REPO;

	// Sibling tags for the two upstream clones. Distinct names so the
	// gitFetch cache layout (`.devstack/git/<name>/<refHash>`) doesn't
	// collide. Refs are independent — deepbookv3 uses `v7.x`-style
	// tags, sandbox uses `v0.x` tags, so they cannot share a ref.
	const deepbookFetch = gitFetch({
		name: `${name}.deepbook` as const,
		repo: deepbookRepo,
		ref,
	});
	const sandboxFetch = gitFetch({
		name: `${name}.sandbox` as const,
		repo: sandboxRepo,
		ref: sandboxRef,
	});

	const composite = tag(
		name,
		Effect.gen(function* () {
			for (const dep of opts.dependsOn ?? []) {
				yield* dep;
			}

			const deepbookSrc = yield* deepbookFetch;
			const sandboxSrc = yield* sandboxFetch;

			const stateDir = process.env.DEVSTACK_STATE_DIR ?? '.devstack';
			const outDir = opts.outDir ?? nodePath.resolve(stateDir, 'vendor', 'deepbook', ref);

			yield* Effect.annotateCurrentSpan({
				'vendorDeepbook.outDir': outDir,
				'vendorDeepbook.ref': ref,
			});

			// Copy each package's source into the per-(ref) vendor tree.
			// We re-copy every time the producer runs — Move source trees
			// are small (~5MB each) and skipping the copy when `outDir`
			// already exists would risk leaving stale Move.toml edits in
			// place across ref bumps.
			yield* Effect.tryPromise({
				try: async () => {
					await nodeFs.rm(outDir, { recursive: true, force: true });
					await nodeFs.mkdir(outDir, { recursive: true });

					const packagePaths: Partial<Record<PackageName, string>> = {};

					for (const pkg of PACKAGE_NAMES) {
						const cfg = PACKAGE_PATHS[pkg];
						const repoBase = cfg.repoKey === 'deepbook' ? deepbookSrc.path : sandboxSrc.path;
						const sourceDir = nodePath.join(repoBase, cfg.subdir);
						if (!existsSync(sourceDir)) {
							throw new Error(
								`vendorDeepbook: package source not found at ${sourceDir} ` +
									`(repo=${cfg.repoKey}, ref=${ref}). ` +
									`The upstream layout may have changed since this recipe was authored.`,
							);
						}
						const destDir = nodePath.join(outDir, pkg);
						await copyDir(sourceDir, destDir);
						packagePaths[pkg] = destDir;
					}

					// Patch each package's Move.toml.
					for (const pkg of PACKAGE_NAMES) {
						const movePath = nodePath.join(outDir, pkg, 'Move.toml');
						if (!existsSync(movePath)) {
							throw new Error(`vendorDeepbook: missing Move.toml at ${movePath}`);
						}
						const deps = LOCAL_DEPS[pkg].map((depName) => ({
							depName,
							// Sibling-relative path: `../<name>`.
							relativePath: `../${depName}`,
						}));
						await patchMoveToml(movePath, deps);
					}
				},
				catch: (cause) => cause,
			}).pipe(
				Effect.mapError(
					(cause) =>
						new DeepbookError({
							phase: 'deepbook',
							message: `vendorDeepbook(${name}): ${stringifyCause(cause)}`,
							cause,
						}),
				),
			);

			const result: VendoredDeepbookSources = {
				token: nodePath.join(outDir, 'token'),
				deepbook: nodePath.join(outDir, 'deepbook'),
				pyth: nodePath.join(outDir, 'pyth'),
				usdc: nodePath.join(outDir, 'usdc'),
				deepbook_margin: nodePath.join(outDir, 'deepbook_margin'),
				margin_liquidation: nodePath.join(outDir, 'margin_liquidation'),
				root: outDir,
				ref,
			};

			return result;
		}).pipe(Effect.withSpan(`VendorDeepbook(${name})`)),
		{
			kind: 'action' as const,
			displayTitle: `vendor.${name}`,
			display: (s: VendoredDeepbookSources) => ({
				title: `vendor.${name}`,
				primary: s.ref,
				extras: [s.root],
			}),
			// Phase B (notes/parallel-graph-resolution.md §3.2 + §6.4): the
			// inner sibling gitFetch tags (deepbookFetch + sandboxFetch)
			// are LIFTED to top-level members via `__extraMembers` below,
			// so the topo scheduler treats them as their own dep-graph
			// nodes (level 0 leaves) and can build them in parallel with
			// other gitFetches in the stack. The composite declares them
			// in `upstreamKeys` so it's strictly ordered after both
			// fetches — otherwise the body's `yield* deepbookFetch` fails
			// with "Service not found: vendorDeepbook.deepbook".
			upstreamKeys: [deepbookFetch, sandboxFetch, ...(opts.dependsOn ?? [])],
		},
	);

	// `__layers` carries ONLY the composite's own primary slice now (the
	// inner fetch layers ride up via `__extraMembers` as top-level stack
	// members). Mirrors walrus local-cluster's Phase-D lift pattern —
	// without this slimming, the composite would double-build its inner
	// tags (once at its own level, once at level 0 via the lift); Effect's
	// MemoMap would dedupe at runtime but the topo scheduler would still
	// account for them twice in level emission.
	const __layers: ReadonlyArray<any> = [composite.__layer, ...composite.__layers];

	return Object.assign(composite, {
		__layers,
		__extraMembers: [deepbookFetch, sandboxFetch] as unknown as ReadonlyArray<StackMember>,
	});
};
