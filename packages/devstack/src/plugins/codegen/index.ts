// Codegen plugin. Owns one Emit action:
//
//   codegen.generate — Two outputs per successful run:
//                      1. Move bindings: iterates `registry.packages.list()`,
//                         filters to entries with a host-resolvable `path`,
//                         runs `sui move summary`, then calls
//                         `@mysten/codegen`'s `generateFromPackageSummary`
//                         per package. Output lands under `<appDir>/<output>`
//                         (default `src/generated/sui`).
//                      2. Typed manifest: a single `manifest.ts` file at
//                         `<output>/../manifest.ts` (default
//                         `src/generated/manifest.ts`) that re-projects the
//                         registry snapshot with a `: Manifest` annotation
//                         so apps don't re-type the four core registry kinds
//                         (services, accounts, packages, tokens) at every
//                         call site. Plugin namespaces stay `unknown` and
//                         are cast in app code (`src/lib/deployment.ts`).
//
// `dependsOnKind: ['packages', 'accounts', 'services', 'tokens']` means the
// reconciler re-fires this Emit whenever any core registry kind dirties.
// Plugin namespaces aren't enumerable at action-construction time, so
// changes scoped to plugin namespaces alone (no core kind dirty in the
// same cycle) won't trigger a re-emit — in practice they always co-dirty
// with `packages` because Register/Seed actions follow Publish. The
// `getStatus` gate also drops back to `ok: false` whenever the on-disk
// `manifest.ts` content drifts from the current registry snapshot, so
// any registry change of consequence regenerates.
//
// Pathless registry entries (imported packages — deepbook, seal, walrus —
// whose source lives inside a docker image, not on the host) are silently
// skipped: only first-party Move packages with on-host sources get
// codegen output.
//
// Each package's emitted builders use the `mvrName(pkgName)` string as
// their `package` placeholder (e.g. `@local/connect-four`). The plugin
// publishes the resolved placeholder onto the package's registry record
// (`Package.mvrPlaceholder`); `localnetMvrOverrides(manifest)` reads it
// back so the SDK's `namedPackagesPlugin` resolves the placeholder to
// live `packageId`s at transaction build time. Apps wire it via
// `localnetDappKitConfig` and no longer need `bindPackage`.

import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { generateFromPackageSummary } from '@mysten/codegen';
import { emit } from '../../actions/emit.js';
import type { ActionRunContext, Package, Plugin } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';
import type { InternalRegistry } from '../../registry/index.js';
import { defaultMvrName } from './mvr.js';

const DEFAULT_OUTPUT = 'src/generated/sui';

interface CodegenPluginOptions {
	/** Output dir relative to the app root. Default `src/generated/sui`. */
	output?: string;
	/** Map a registry package name to its MVR-shape placeholder used in
	 * codegen-emitted `tx.moveCall({ package: '<placeholder>', ... })`.
	 * Defaults to {@link defaultMvrName}.
	 *
	 * The mapper's output must be a valid MVR name (kebab-case app, valid
	 * SuiNS-shaped org with `@` prefix). Apps that override this MUST
	 * pass the same mapper to `localnetMvrOverrides({ mvrName })` so the
	 * placeholder used in the codegen output matches the override key. */
	mvrName?: (pkgName: string) => string;
}

export const codegen = (opts: CodegenPluginOptions = {}): Plugin<'codegen.generate'> => {
	const output = opts.output ?? DEFAULT_OUTPUT;
	const mvrName = opts.mvrName ?? defaultMvrName;
	return definePlugin({
		name: 'codegen',
		// Folded into the snapshot id. Output dir + mvrName shape change
		// what gets written into `src/generated/` — both belong in the
		// invalidator. The actual codegen output is in `src/generated/`
		// (gitignored), not `<stackDir>`, so the snapshot's host capture
		// doesn't include it; bumping these regens on next `up`.
		inputs: { output, mvrShape: mvrName('_') },
		actions: () => [
			emit({
				name: 'generate',
				// Re-fire on any registry kind that the typed `manifest.ts`
				// projection consumes. Plugin namespaces aren't enumerable
				// at action-construction time, so changes scoped to plugin
				// namespaces alone (no core kind dirty in the same cycle)
				// won't trigger a re-emit — in practice they always co-dirty
				// with `packages` because Register/Seed actions follow Publish.
				dependsOnKind: ['packages', 'accounts', 'services', 'coin/tokens'],
				// Include a sample of the mvrName mapper so changing it busts
				// the input hash and triggers a re-emit. Probe value is just
				// `mvrName('_')` — distinct outputs across mappers without
				// collision against any real package name.
				inputs: { output, mvrShape: mvrName('_') },
				provides: {
					// Republish the placeholder onto every codegen-able package
					// each successful cycle, so a fresh manifest hydration sees
					// the placeholder even if `run` was skipped.
					registry: (ctx) => publishPlaceholders(ctx, mvrName),
				},
				getStatus: async (ctx) => {
					const outputAbs = resolvedOutputDir(ctx.appDir, output);
					const manifestPath = resolvedManifestPath(outputAbs);
					const expectedManifest = renderTypedManifest(ctx);
					if (
						!existsSync(manifestPath) ||
						readFileSync(manifestPath, 'utf8') !== expectedManifest
					) {
						return { ok: false, detail: 'manifest.ts stale' };
					}
					const targets = codegenTargets(ctx.registry.packages.list());
					const targetNames = new Set(targets.map((t) => t.name));
					if (existsSync(outputAbs)) {
						// A leftover per-package binding dir from a removed Publish
						// action — surface as stale so `run()` cleans it up.
						const stale = staleBindingDirs(outputAbs, targetNames);
						if (stale.length > 0) {
							return { ok: false, detail: `stale bindings: ${stale.join(', ')}` };
						}
					}
					if (targets.length === 0) return { ok: true, detail: 'no codegen-able packages' };
					if (!existsSync(outputAbs)) {
						return { ok: false, detail: `${output} missing` };
					}
					for (const pkg of targets) {
						const subdir = join(outputAbs, pkg.name);
						if (!existsSync(subdir)) {
							return { ok: false, detail: `${pkg.name} bindings missing` };
						}
						// Move sources newer than the bindings → re-emit. Cheap proxy
						// for "did the user touch the .move file since last codegen?"
						// without re-running `sui move summary`. Use per-package subdir
						// mtime so writes to sibling files don't invalidate the comparison.
						const subMtime = statSync(subdir).mtimeMs;
						if (newestMoveSourceMtime(pkg.path) > subMtime) {
							return { ok: false, detail: `${pkg.name} sources newer than bindings` };
						}
					}
					return { ok: true, detail: `${targets.length} package(s) up-to-date` };
				},
				run: async (ctx) => {
					const outputAbs = resolvedOutputDir(ctx.appDir, output);
					writeTypedManifest({ ctx, outputAbs });
					const targets = codegenTargets(ctx.registry.packages.list());
					if (targets.length === 0) {
						// No bindings to generate; just clean stale subdirs of
						// existing output (no atomic swap needed since there
						// are no per-package writes to race against vite).
						if (existsSync(outputAbs)) {
							for (const stale of staleBindingDirs(outputAbs, new Set())) {
								rmSync(join(outputAbs, stale), { recursive: true, force: true });
							}
						}
						return;
					}
					await ensureSuiOnPath();
					// Atomic-ish output swap: write the full per-package
					// codegen tree to a sibling staging dir, then dir-swap
					// over the live output. The previous behavior wrote each
					// per-package subdir under `outputAbs` directly, which
					// left vite's HMR seeing a half-written tree mid-cycle —
					// `vault.ts` would land before its sibling
					// `utils/index.ts` and vite's pre-transform would error
					// out with "Failed to resolve import '../utils/index.ts'"
					// repeatedly until the next file change kicked the
					// pipeline. Staging + a single rename collapses the
					// observable update to one filesystem event so vite
					// always sees a consistent tree.
					const stagingAbs = `${outputAbs}.staging-${process.pid}`;
					if (existsSync(stagingAbs)) {
						rmSync(stagingAbs, { recursive: true, force: true });
					}
					mkdirSync(stagingAbs, { recursive: true });
					try {
						// Per-package codegen is independent — `sui move summary` runs in
						// each package's own dir, `generateFromPackageSummary` writes to
						// distinct subdirs. Run in parallel; on a 4-package app this cuts
						// the codegen step from ~2s serial to ~600ms.
						await Promise.all(
							targets.map((pkg) =>
								runCodegenForPackage({
									ctx,
									pkg,
									output,
									mvrName,
									outputDirOverride: stagingAbs,
								}),
							),
						);
						// Promote staging → live. The "rename old aside, rename
						// new in" pattern keeps the live `outputAbs` populated
						// at every observable moment except for one
						// microsecond between the two renames — short enough
						// that vite's chokidar coalesces it. The old tree
						// goes to `<outputAbs>.discarding-<pid>` so the
						// rmSync that frees its inodes can run after the
						// swap (off the hot path).
						const discardAbs = `${outputAbs}.discarding-${process.pid}`;
						if (existsSync(outputAbs)) {
							if (existsSync(discardAbs)) {
								rmSync(discardAbs, { recursive: true, force: true });
							}
							renameSync(outputAbs, discardAbs);
						}
						renameSync(stagingAbs, outputAbs);
						if (existsSync(discardAbs)) {
							rmSync(discardAbs, { recursive: true, force: true });
						}
					} catch (err) {
						// Generation or swap failed; leave the existing
						// tree in place and clean up staging so the next
						// cycle starts clean.
						if (existsSync(stagingAbs)) {
							rmSync(stagingAbs, { recursive: true, force: true });
						}
						throw err;
					}
				},
			}),
		],
	});
};

/** Test helper. Pure function — same input, same output; no I/O. */
export function renderTypedManifest(ctx: ActionRunContext): string {
	const reg = ctx.registry as InternalRegistry;
	const manifest = {
		app: ctx.appName,
		network: ctx.network,
		emittedAt: '',
		registry: reg.snapshot(),
	};
	const json = JSON.stringify(manifest, manifestReplacer, '\t');
	return `// AUTO-GENERATED by @mysten-incubation/devstack codegen — do not edit.
// Re-emitted on every successful \`devstack apply\`. Reflects the registry
// state at last apply.
//
// The \`Manifest\` annotation gives apps strong typing on the four core
// registry kinds (services, accounts, packages, tokens) without re-typing
// at every call site. Plugin namespaces stay \`unknown\` — apps cast to a
// specific shape in their per-app projection (typically \`src/lib/deployment.ts\`).

import type { Manifest } from '@mysten-incubation/devstack';

export const manifest: Manifest = ${json};
`;
}

function writeTypedManifest(opts: { ctx: ActionRunContext; outputAbs: string }): void {
	const file = resolvedManifestPath(opts.outputAbs);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, renderTypedManifest(opts.ctx), 'utf8');
}

/** The typed manifest is colocated one level up from the Move-bindings
 * output dir — `<appDir>/src/generated/manifest.ts` for the default
 * `output: 'src/generated/sui'`. Lives outside the bindings dir on
 * purpose: bindings are gitignored (large, regenerated, package-specific);
 * the typed manifest is small, app-wide, and committed so apps typecheck
 * on a fresh clone before the first `devstack apply`. */
function resolvedManifestPath(outputAbs: string): string {
	return resolve(outputAbs, '..', 'manifest.ts');
}

function manifestReplacer(key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	// Strip `path` from package entries before serializing the typed
	// manifest. The path is an absolute on-host filesystem path used by
	// the in-process codegen runtime; baking it into the committed
	// `manifest.ts` leaks one developer's home dir into every other
	// developer's diff (and is meaningless after `git clone` to a
	// different machine anyway). The runtime registry retains `path` —
	// it's set fresh by `publishMove`'s `provides.registry` on every
	// cycle. No consumer reads `path` off the typed manifest bundle.
	if (key === 'path' && typeof value === 'string' && value.startsWith('/')) return undefined;
	return value;
}

/** Per-package binding subdirs in `<output>/` whose package no longer
 * appears in the registry (e.g. an app removed a `publishMove(...)` from
 * its setup). Used by `getStatus` to surface staleness and by `run` to
 * actually delete the leftover dirs. The `manifest.ts` sibling is at
 * `<output>/../manifest.ts`, not inside `<output>/`, so it isn't a
 * candidate for deletion. */
function staleBindingDirs(outputAbs: string, keep: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(outputAbs, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!keep.has(entry.name)) out.push(entry.name);
	}
	return out;
}

interface CodegenTarget {
	name: string;
	path: string;
}

function codegenTargets(pkgs: Package[]): CodegenTarget[] {
	const out: CodegenTarget[] = [];
	for (const pkg of pkgs) {
		if (pkg.path === undefined) continue;
		out.push({ name: pkg.name, path: pkg.path });
	}
	return out;
}

/** Mirror the codegen-emitted placeholder onto every codegen-able
 * package's registry record so `localnetMvrOverrides(manifest)` can
 * derive the override map without re-running the mapper. Idempotent —
 * re-registers each package with its existing fields plus
 * `mvrPlaceholder`. */
function publishPlaceholders(
	ctx: ActionRunContext,
	mvrName: (pkgName: string) => string,
): void {
	for (const pkg of ctx.registry.packages.list()) {
		if (pkg.path === undefined) continue;
		const placeholder = mvrName(pkg.name);
		if (pkg.mvrPlaceholder === placeholder) continue;
		ctx.registry.packages.register({ ...pkg, mvrPlaceholder: placeholder });
	}
}

function resolvedOutputDir(appDir: string, output: string): string {
	return isAbsolute(output) ? output : resolve(appDir, output);
}

async function runCodegenForPackage(opts: {
	ctx: ActionRunContext;
	pkg: CodegenTarget;
	output: string;
	mvrName: (pkgName: string) => string;
	/** When set, write to this directory instead of the resolved
	 * default — used by the staging-then-swap path in `run` to avoid
	 * vite seeing a half-written tree mid-cycle. */
	outputDirOverride?: string;
}): Promise<void> {
	const { ctx, pkg, output, mvrName } = opts;
	if (!existsSync(pkg.path)) {
		throw new Error(`codegen: package path not found for ${pkg.name}: ${pkg.path}`);
	}
	const absoluteOutput = opts.outputDirOverride ?? resolvedOutputDir(ctx.appDir, output);

	// `generateFromPackageSummary` reads the summary that `sui move
	// summary` produces under `<pkg.path>/package_summaries/`. Run that
	// step here ourselves (the CLI codegen wraps it; we're skipping the
	// CLI to gain control over the `package` placeholder string). Spawn
	// (not execSync) so multiple packages parallelize via `Promise.all`
	// in `run` — execSync would block the event loop and serialize them.
	const summaryRes = await runShell({
		cmd: 'sui',
		args: ['move', 'summary'],
		cwd: pkg.path,
	});
	if (summaryRes.code !== 0) {
		throw new Error(
			`codegen: \`sui move summary\` failed for ${pkg.name} at ${pkg.path} ` +
				`(exit ${summaryRes.code}): ${summaryRes.stderr.trim() || summaryRes.stdout.trim()}`,
		);
	}

	const placeholder = mvrName(pkg.name);
	await generateFromPackageSummary({
		package: {
			path: pkg.path,
			package: placeholder,
			packageName: pkg.name,
		},
		prune: true,
		outputDir: absoluteOutput,
		// `.ts` import specifiers (not `.js`) so Node 24's native
		// type-stripping resolves in-tree imports directly, and `devstack
		// console`'s plain `await import()` works without a loader. Vite
		// and esbuild both handle `.ts` extensions natively; tsc requires
		// `allowImportingTsExtensions: true` (set in `@mysten-incubation/
		// tsconfig` so every example inherits it).
		importExtension: '.ts',
	});

	const expectedSubdir = join(absoluteOutput, pkg.name);
	if (!existsSync(expectedSubdir)) {
		throw new Error(
			`codegen: generateFromPackageSummary returned without writing ${expectedSubdir}. ` +
				`Common cause: ${pkg.name}'s Move.toml is missing an [addresses] block ` +
				`matching the package's summary subdir.`,
		);
	}
}

async function ensureSuiOnPath(): Promise<void> {
	const r = await runShell({ cmd: 'sui', args: ['--version'] });
	if (r.code !== 0) {
		throw new Error(
			'codegen: `sui` binary not found on PATH. Install the Sui CLI ' +
				'(>= 1.51.1) — see https://docs.sui.io/guides/developer/getting-started/sui-install.',
		);
	}
}

interface ShellResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runShell(opts: { cmd: string; args: string[]; cwd?: string }): Promise<ShellResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (err) => {
			resolvePromise({ code: 1, stdout, stderr: stderr + String(err) });
		});
		child.on('close', (code) => {
			resolvePromise({ code: code ?? 0, stdout, stderr });
		});
	});
}

function newestMoveSourceMtime(packagePath: string): number {
	let newest = 0;
	const stack: string[] = [packagePath];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		// `sui move summary` walks Move.toml + sources/; ignore build/ artifacts.
		if (dir.endsWith(`${packagePath.endsWith('/') ? '' : '/'}build`)) continue;
		let entries: import('node:fs').Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'build') continue;
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith('.move') && entry.name !== 'Move.toml') continue;
			try {
				const m = statSync(full).mtimeMs;
				if (m > newest) newest = m;
			} catch {
				// ignore
			}
		}
	}
	return newest;
}
