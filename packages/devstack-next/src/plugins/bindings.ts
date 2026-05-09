import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Dep } from '../engine/types.js';
import { define } from '../factories/define.js';
import { hashMoveTree } from '../helpers/publish-move.js';
import type { Package } from '../shapes/index.js';

// `@mysten/codegen` reaches into `node:fs/promises` + `path` from its
// own static surface. Hide the specifier behind a dynamic expression so
// any consumer that imports `devstack-next/plugins` doesn't statically
// pull node-only modules into a browser bundle. The dynamic call is
// awaited at module load (server-side only — plugins never run in the
// browser) so each `run()` doesn't pay the import cost.
const mystenCodegen = (await import(
	/* @vite-ignore */ ['@mysten', 'codegen'].join('/')
)) as typeof import('@mysten/codegen');

const exec = promisify(execFile);

export interface BindingsOptions {
	/** Packages to emit bindings for. Each Dep returns a Package; only
	 * those with a `path` set become emission targets — packages without
	 * source on host (canonical deepbook IDs, upstream imports) are
	 * silently skipped. */
	packages: Dep<void, Package>[];
	/** Output dir relative to `env.appDir` (or absolute). Default
	 * `src/generated/sui`. Per-package bindings land at
	 * `<output>/<pkg.name>/`. */
	output?: string;
	/** Logical node name. Default `'bindings'`. */
	name?: string;
	/** Import extension for emitted import specifiers. Default `'.ts'`
	 * so Node 24's native type-stripping resolves in-tree imports
	 * directly. Set to `'.js'` for projects that build before
	 * publishing. */
	importExtension?: '.ts' | '.js' | '';
}

export interface BindingsState {
	outputPath: string;
	emittedAt: number;
	/** Logical names of packages that produced bindings this cycle. */
	targets: string[];
}

interface ResolvedDeps {
	packages: Package[];
}

interface Target {
	name: string;
	path: string;
	mvrPlaceholder: string;
}

// `bindings({ packages })` — emit typed Move bindings via `sui move
// summary` + `@mysten/codegen`. Sibling to `manifest`: where manifest
// projects runtime values into a JSON-shaped TS file, bindings emits
// per-package builder modules that the manifest is consumed alongside.
//
// One Producer for the whole pass — per-package errors fail the cycle
// (Move source bugs SHOULD halt) — but `sui move summary` and
// `generateFromPackageSummary` run in parallel across packages.
//
// Atomic dir swap (stage → rename old aside → rename staging in)
// ensures Vite never sees a partially-written tree mid-cycle, which
// previously surfaced as repeated "Failed to resolve import" errors
// when one binding file landed before its sibling.
//
// Re-fires on:
//   - Output path / importExtension change.
//   - Any package's identity flip (upstream cascade).
//   - Move source content change (independent `hashMoveTree` per
//     target, folded into input hash). This catches "edited a .move
//     file without re-publishing" — bindings refresh even when the
//     packageId stays the same.
export function bindings(opts: BindingsOptions) {
	const output = opts.output ?? 'src/generated/sui';
	const name = opts.name ?? 'bindings';
	const importExtension = opts.importExtension ?? '.ts';

	const deps = { packages: opts.packages };

	return define<BindingsState, {}, typeof deps>({
		name,
		deps,
		inputs: ({ env, deps }) => {
			const targets = collectTargets((deps as unknown as ResolvedDeps).packages);
			return {
				output,
				importExtension,
				targets: targets
					.map((t) => ({
						name: t.name,
						mvr: t.mvrPlaceholder,
						source: hashMoveTree(t.path),
					}))
					.sort((a, b) => a.name.localeCompare(b.name)),
				appDir: env.appDir,
			};
		},
		getStatus: async ({ env, deps }) => {
			const targets = collectTargets((deps as unknown as ResolvedDeps).packages);
			const outputAbs = resolveOutput(env.appDir, output);
			if (targets.length === 0) {
				// Nothing to emit. Stale subdirs (from a prior config that
				// included packages this one drops) surface as ok: false so
				// run() can clean them up.
				if (!existsSync(outputAbs)) return { ok: true };
				return staleSubdirs(outputAbs, new Set()).length === 0
					? { ok: true }
					: { ok: false, detail: 'stale binding subdirs' };
			}
			if (!existsSync(outputAbs)) {
				return { ok: false, detail: `${output} missing` };
			}
			const expected = new Set(targets.map((t) => t.name));
			for (const t of targets) {
				if (!existsSync(join(outputAbs, t.name))) {
					return { ok: false, detail: `${t.name} bindings missing` };
				}
			}
			const stale = staleSubdirs(outputAbs, expected);
			if (stale.length > 0) {
				return { ok: false, detail: `stale: ${stale.join(', ')}` };
			}
			return { ok: true };
		},
		run: async ({ env, deps, log }) => {
			const targets = collectTargets((deps as unknown as ResolvedDeps).packages);
			const outputAbs = resolveOutput(env.appDir, output);

			if (targets.length === 0) {
				// No packages to bind. Clean leftover subdirs (e.g. a
				// publishMove dropped from the stack) so the tree stays
				// honest, then return. No staging needed — there's nothing
				// to write atomically.
				if (existsSync(outputAbs)) {
					for (const stale of staleSubdirs(outputAbs, new Set())) {
						rmSync(join(outputAbs, stale), { recursive: true, force: true });
					}
				}
				return { outputPath: outputAbs, emittedAt: Date.now(), targets: [] };
			}

			await ensureSuiOnPath();

			// Stage to a sibling dir; promote with a single rename so Vite
			// always observes a coherent tree.
			const staging = `${outputAbs}.staging-${process.pid}`;
			if (existsSync(staging)) {
				rmSync(staging, { recursive: true, force: true });
			}
			mkdirSync(staging, { recursive: true });

			try {
				await Promise.all(
					targets.map(async (t) => {
						log(`sui move summary → ${t.name}`);
						await exec('sui', ['move', 'summary'], { cwd: t.path });
						await mystenCodegen.generateFromPackageSummary({
							package: {
								path: t.path,
								package: t.mvrPlaceholder,
								packageName: t.name,
							},
							prune: true,
							outputDir: staging,
							importExtension,
						});
						const expected = join(staging, t.name);
						if (!existsSync(expected)) {
							throw new Error(
								`bindings: generateFromPackageSummary returned without writing ${expected}. ` +
									`Common cause: ${t.name}'s Move.toml is missing an [addresses] block ` +
									`matching the package's summary subdir.`,
							);
						}
					}),
				);

				// Promote: rename old aside, rename staging in. The old tree
				// goes to `<output>.discarding-<pid>` so the rmSync that frees
				// its inodes runs after the swap (off the hot path).
				const discard = `${outputAbs}.discarding-${process.pid}`;
				if (existsSync(outputAbs)) {
					if (existsSync(discard)) {
						rmSync(discard, { recursive: true, force: true });
					}
					renameSync(outputAbs, discard);
				}
				renameSync(staging, outputAbs);
				if (existsSync(discard)) {
					rmSync(discard, { recursive: true, force: true });
				}
			} catch (err) {
				if (existsSync(staging)) {
					rmSync(staging, { recursive: true, force: true });
				}
				throw err;
			}

			return {
				outputPath: outputAbs,
				emittedAt: Date.now(),
				targets: targets.map((t) => t.name),
			};
		},
	});
}

function collectTargets(packages: Package[]): Target[] {
	const seen = new Set<string>();
	const out: Target[] = [];
	for (const pkg of packages) {
		if (pkg.path === undefined) continue;
		if (seen.has(pkg.name)) continue;
		seen.add(pkg.name);
		out.push({
			name: pkg.name,
			path: pkg.path,
			mvrPlaceholder: pkg.mvrPlaceholder ?? `@local/${pkg.name}`,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

function staleSubdirs(outputAbs: string, keep: ReadonlySet<string>): string[] {
	if (!existsSync(outputAbs)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(outputAbs, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith('.staging-') || entry.name.startsWith('.discarding-')) continue;
		if (!keep.has(entry.name)) out.push(entry.name);
	}
	return out;
}

function resolveOutput(appDir: string, output: string): string {
	return isAbsolute(output) ? output : resolve(appDir, output);
}

async function ensureSuiOnPath(): Promise<void> {
	try {
		await exec('sui', ['--version']);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ENOENT') {
			throw new Error(
				'bindings: `sui` binary not found on PATH. Install the Sui CLI (>= 1.51.1) — ' +
					'see https://docs.sui.io/guides/developer/getting-started/sui-install.',
			);
		}
		throw err;
	}
}
