// Codegen plugin. Owns one Emit action:
//
//   codegen.generate — Iterates `registry.packages.list()`, filters to
//                      entries with a host-resolvable `path`, runs
//                      `sui move summary`, then calls
//                      `@mysten/codegen`'s `generateFromPackageSummary`
//                      directly per package. Output lands at
//                      `<appDir>/<output>` (default `src/generated/sui`).
//
// `dependsOnKind: ['packages']` means the reconciler re-fires this Emit
// whenever the packages kind dirties — i.e. after any Publish action runs
// in the same cycle. The Emit's input hash also includes a stable
// fingerprint of (name, packageId, path) per package, so the warm-cycle
// `getStatus` short-circuits when no package the codegen cares about has
// changed since the last write.
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

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { generateFromPackageSummary } from '@mysten/codegen';
import { emit } from '../../actions/emit.js';
import type { ActionRunContext, Package } from '../../core/types.js';
import { definePlugin } from '../../plugin.js';

const DEFAULT_OUTPUT = 'src/generated/sui';

/**
 * Default MVR-shape placeholder for a registry package. Move package
 * names typically use snake_case (`mock_usdc`); MVR app-name validation
 * requires kebab (`mock-usdc`). The default kebabizes and prefixes
 * `@local/`. Apps with a custom org configure `codegen({ mvrName: ... })`
 * AND pass the same mapper to `localnetMvrOverrides({ mvrName: ... })`
 * so the codegen output and the SuiClient's overrides agree on names.
 */
export function defaultMvrName(pkgName: string): string {
	return `@local/${pkgName.replace(/_/g, '-')}`;
}

export interface CodegenPluginOptions {
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

export const codegen = (opts: CodegenPluginOptions = {}) => {
	const output = opts.output ?? DEFAULT_OUTPUT;
	const mvrName = opts.mvrName ?? defaultMvrName;
	return definePlugin({
		name: 'codegen',
		actions: () => [
			emit({
				name: 'generate',
				dependsOnKind: ['packages'],
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
					const targets = codegenTargets(ctx.registry.packages.list());
					if (targets.length === 0) return { ok: true, detail: 'no codegen-able packages' };
					const outputAbs = resolvedOutputDir(ctx.appDir, output);
					if (!existsSync(outputAbs)) {
						return { ok: false, detail: `${output} missing` };
					}
					const outMtime = statSync(outputAbs).mtimeMs;
					for (const pkg of targets) {
						const subdir = join(outputAbs, pkg.name);
						if (!existsSync(subdir)) {
							return { ok: false, detail: `${pkg.name} bindings missing` };
						}
						// Move sources newer than the bindings → re-emit. Cheap proxy
						// for "did the user touch the .move file since last codegen?"
						// without re-running `sui move summary`.
						if (newestMoveSourceMtime(pkg.path) > outMtime) {
							return { ok: false, detail: `${pkg.name} sources newer than bindings` };
						}
					}
					return { ok: true, detail: `${targets.length} package(s) up-to-date` };
				},
				run: async (ctx) => {
					const targets = codegenTargets(ctx.registry.packages.list());
					if (targets.length === 0) return;
					await ensureSuiOnPath();
					const outputAbs = resolvedOutputDir(ctx.appDir, output);
					mkdirSync(outputAbs, { recursive: true });
					for (const pkg of targets) {
						await runCodegenForPackage({ ctx, pkg, output, mvrName });
					}
				},
			}),
		],
	});
};

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
}): Promise<void> {
	const { ctx, pkg, output, mvrName } = opts;
	if (!existsSync(pkg.path)) {
		throw new Error(`codegen: package path not found for ${pkg.name}: ${pkg.path}`);
	}
	const absoluteOutput = resolvedOutputDir(ctx.appDir, output);

	// `generateFromPackageSummary` reads the summary that `sui move
	// summary` produces under `<pkg.path>/package_summaries/`. Run that
	// step here ourselves (the CLI codegen wraps it; we're skipping the
	// CLI to gain control over the `package` placeholder string).
	try {
		execSync('sui move summary', { cwd: pkg.path, stdio: 'ignore' });
	} catch (err) {
		throw new Error(
			`codegen: \`sui move summary\` failed for ${pkg.name} at ${pkg.path}: ${
				err instanceof Error ? err.message : String(err)
			}`,
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
		importExtension: '.js',
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
			entries = readdirSyncSafe(dir);
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

function readdirSyncSafe(dir: string): import('node:fs').Dirent[] {
	const fs = require('node:fs') as typeof import('node:fs');
	return fs.readdirSync(dir, { withFileTypes: true });
}
