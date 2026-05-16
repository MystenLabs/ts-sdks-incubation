// BindingsEmitter — TypeScript bindings codegen plug-in. Runs
// `sui move summary` against each LOCAL package's source tree, hands
// the result to `@mysten/codegen`, and writes typed bindings under
// `<outputDir>/<package-name>/`.
//
// Local-only: `KnownPackage(...)` entries (which carry no `sourcePath`)
// are skipped — bindings need the upstream Move source to feed `sui
// move summary`.
//
// Atomic dir swap (stage → rename existing aside → rename staging in)
// so a Vite dev server never observes a half-written tree mid-cycle.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { generateFromPackageSummary } from '@mysten/codegen';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { SuiBuildContainer } from '../../engine/sui-build-container.js';
import { CodegenError } from '../errors.js';
import { defineEmitter, type CodegenContext, type Emitter } from '../define-emitter.js';

// Per-output-dir cache of the last input fingerprint we successfully
// emitted. HIGH-C5: pre-fix, every supervisor cycle re-ran the full
// `sui move summary` + `generateFromPackageSummary` pipeline + atomic
// dir swap, even when no Move source had changed — Vite's watcher
// then fired HMR reloads on every restart. The fingerprint is
// `sha256(target name + sourcePath + mvrPlaceholder + max mtime
// across .move/.toml/.lock files in sourcePath)`. Module-local map
// keyed by the absolute output path so two Codegen Refs writing to
// different dirs don't share state.
const lastEmitFingerprint = new Map<string, string>();

export interface BindingsEmitterOptions {
	/** Import-extension flavor in generated code. Defaults to `'.ts'`. */
	readonly importExtension?: '.ts' | '.js' | '';
}

interface Target {
	readonly name: string;
	readonly sourcePath: string;
	readonly mvrPlaceholder: string;
}

const collectTargets = (ctx: CodegenContext): ReadonlyArray<Target> => {
	const seen = new Set<string>();
	const targets: Array<Target> = [];
	for (const pkg of ctx.packages) {
		if (pkg.sourcePath === undefined) continue; // skip KnownPackage entries
		if (seen.has(pkg.name)) continue;
		seen.add(pkg.name);
		targets.push({
			name: pkg.name,
			sourcePath: pkg.sourcePath,
			mvrPlaceholder: pkg.mvrPlaceholder,
		});
	}
	return targets.sort((a, b) => a.name.localeCompare(b.name));
};

const runEmit = (
	ctx: CodegenContext,
	importExtension: '.ts' | '.js' | '',
): Effect.Effect<void, CodegenError, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const targets = collectTargets(ctx);
		if (targets.length === 0) return;

		const outputAbs = path.join(ctx.outputDir, 'bindings');
		yield* Effect.annotateCurrentSpan({
			'bindings.output': outputAbs,
			'bindings.targetCount': targets.length,
			'bindings.targets': targets.map((t) => t.name).join(','),
		});

		// HIGH-C5: short-circuit when the inputs haven't moved since the
		// last successful emit. The fingerprint walks each target's
		// source tree for the max mtime of `.move`/`.toml`/`.lock`
		// files (matching what `publishMove`'s `hashMoveSources`
		// considers a publish-input) and folds it with the target's
		// name + path + mvrPlaceholder. Identical fingerprint → the
		// generated bindings on disk are still valid; skipping the
		// emit avoids a wasted `sui move summary` run AND avoids
		// firing Vite's HMR via the atomic dir swap.
		const fingerprint = yield* computeFingerprint(targets);
		if (fingerprint !== undefined && lastEmitFingerprint.get(outputAbs) === fingerprint) {
			yield* Effect.annotateCurrentSpan({
				'bindings.cache': 'hit',
				'bindings.fingerprint': fingerprint,
			});
			return;
		}
		yield* Effect.annotateCurrentSpan({
			'bindings.cache': fingerprint === undefined ? 'unknown' : 'miss',
			'bindings.fingerprint': fingerprint ?? 'undefined',
		});

		// Random staging suffix instead of `process.pid`. Two stacks of
		// the same app forked from a parent supervisor would otherwise
		// collide on the staging dir name (same pid post-fork on
		// platforms that report the parent pid for forked workers).
		const staging = `${outputAbs}.staging-${crypto.randomBytes(6).toString('hex')}`;

		yield* Effect.tryPromise({
			try: () => fs.rm(staging, { recursive: true, force: true }),
			catch: (cause) =>
				new CodegenError({
					emitter: 'bindings',
					phase: 'write',
					message: `failed to clear staging dir ${staging}: ${stringifyCause(cause)}`,
					cause,
				}),
		});
		yield* Effect.tryPromise({
			try: () => fs.mkdir(staging, { recursive: true }),
			catch: (cause) =>
				new CodegenError({
					emitter: 'bindings',
					phase: 'write',
					message: `failed to create staging dir ${staging}: ${stringifyCause(cause)}`,
					cause,
				}),
		});

		// C7: prefer the SuiBuildContainer's pinned `sui` for `sui move
		// summary`. The host `sui` may be a different version than the
		// build container's pinned `sui`, and the resulting summary
		// schema would diverge from what `@mysten/codegen` expects.
		// Fall back to the host `sui` only when the build container
		// can't reach the source (path outside the bind-mount or no
		// build container provisioned at all).
		const buildContainerOpt = yield* Effect.serviceOption(SuiBuildContainer);

		const codegen = Effect.forEach(
			targets,
			(t) =>
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan({ 'bindings.target': t.name });
					yield* Effect.logInfo(`sui move summary -> ${t.name}`);
					if (buildContainerOpt._tag === 'Some' && buildContainerOpt.value.canExec(t.sourcePath)) {
						yield* buildContainerOpt.value.runSummary(t.sourcePath).pipe(
							Effect.mapError(
								(cause) =>
									new CodegenError({
										emitter: 'bindings',
										phase: 'generate',
										message: `${t.name}: sui move summary (in build container) failed: ${stringifyCause(cause)}`,
										cause,
									}),
							),
						);
					} else {
						const summaryCmd = ChildProcess.make('sui', ['move', 'summary'], {
							cwd: t.sourcePath,
						});
						yield* spawner.exitCode(summaryCmd).pipe(
							Effect.mapError(
								(cause) =>
									new CodegenError({
										emitter: 'bindings',
										phase: 'generate',
										message: `${t.name}: sui move summary (host fallback) failed: ${stringifyCause(cause)}`,
										cause,
									}),
							),
						);
					}
					yield* Effect.tryPromise({
						try: () =>
							generateFromPackageSummary({
								package: {
									path: t.sourcePath,
									package: t.mvrPlaceholder,
									packageName: t.name,
								},
								prune: true,
								outputDir: staging,
								importExtension,
							}),
						catch: (cause) =>
							new CodegenError({
								emitter: 'bindings',
								phase: 'generate',
								message: `${t.name}: codegen failed: ${stringifyCause(cause)}`,
								cause,
							}),
					});
					// `generateFromPackageSummary` returns void on success but
					// silently emits nothing if the package's Move.toml lacks
					// an [addresses] entry matching its summary subdir. Probe
					// the staging path so we fail loudly here rather than
					// landing a half-empty tree.
					const expected = path.join(staging, t.name);
					const wrote = yield* Effect.tryPromise({
						try: async () => {
							try {
								await fs.access(expected);
								return true;
							} catch {
								return false;
							}
						},
						catch: () => false,
					}).pipe(Effect.orElseSucceed(() => false));
					if (!wrote) {
						return yield* Effect.fail(
							new CodegenError({
								emitter: 'bindings',
								phase: 'generate',
								message:
									`${t.name}: generateFromPackageSummary returned without writing ${expected}. ` +
									`Common cause: ${t.name}'s Move.toml is missing an [addresses] block matching the package's summary subdir.`,
							}),
						);
					}
				}),
			{ concurrency: 'unbounded' },
		).pipe(
			Effect.tapError(() =>
				Effect.promise(() => fs.rm(staging, { recursive: true, force: true })),
			),
		);

		yield* codegen;

		// Atomic promote: rename existing output aside, rename staging
		// into place, clean up the displaced tree. Vite dev servers
		// watching the output dir never see a half-empty intermediate
		// state.
		const discard = `${outputAbs}.discarding-${process.pid}`;
		yield* Effect.tryPromise({
			try: () => fs.mkdir(path.dirname(outputAbs), { recursive: true }),
			catch: (cause) =>
				new CodegenError({
					emitter: 'bindings',
					phase: 'write',
					message: `failed to create parent of ${outputAbs}: ${stringifyCause(cause)}`,
					cause,
				}),
		});
		const outputExists = yield* Effect.tryPromise({
			try: async () => {
				try {
					await fs.access(outputAbs);
					return true;
				} catch {
					return false;
				}
			},
			catch: () => false,
		}).pipe(Effect.orElseSucceed(() => false));
		if (outputExists) {
			yield* Effect.tryPromise({
				try: () => fs.rm(discard, { recursive: true, force: true }),
				catch: () => undefined,
			}).pipe(Effect.ignore({ log: true }));
			yield* Effect.tryPromise({
				try: () => fs.rename(outputAbs, discard),
				catch: (cause) =>
					new CodegenError({
						emitter: 'bindings',
						phase: 'write',
						message: `failed to rename existing output aside: ${stringifyCause(cause)}`,
						cause,
					}),
			});
		}
		yield* Effect.tryPromise({
			try: () => fs.rename(staging, outputAbs),
			catch: (cause) =>
				new CodegenError({
					emitter: 'bindings',
					phase: 'write',
					message: `failed to promote staging into ${outputAbs}: ${stringifyCause(cause)}`,
					cause,
				}),
		});
		yield* Effect.tryPromise({
			try: () => fs.rm(discard, { recursive: true, force: true }),
			catch: () => undefined,
		}).pipe(Effect.ignore({ log: true }));

		// Stash the fingerprint AFTER the swap landed so a failure
		// upstream (codegen, swap, post-swap rm) leaves the cache
		// invalid and forces a re-emit next cycle.
		if (fingerprint !== undefined) {
			lastEmitFingerprint.set(outputAbs, fingerprint);
		}
	});

const computeFingerprint = (
	targets: ReadonlyArray<Target>,
): Effect.Effect<string | undefined> =>
	Effect.gen(function* () {
		const hash = crypto.createHash('sha256');
		for (const t of targets) {
			hash.update(`${t.name}\0${t.sourcePath}\0${t.mvrPlaceholder}\0`);
			const maxMtime = yield* Effect.tryPromise({
				try: () => maxSourceMtime(t.sourcePath),
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined));
			if (maxMtime === undefined) {
				// A tree we couldn't stat (missing source dir, perms): refuse
				// to short-circuit and let the emit pipeline surface the
				// underlying error with a clearer message.
				return undefined;
			}
			hash.update(String(maxMtime));
			hash.update('\0');
		}
		return hash.digest('hex').slice(0, 24);
	});

// Walk the source tree once and return the max mtime in ms across
// every Move-input file (`.move`, `Move.toml`, `Move.lock`). Hidden
// dirs and `build`/`node_modules` are skipped to mirror the publish
// hash's filter.
async function maxSourceMtime(root: string): Promise<number> {
	let max = 0;
	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (entry.name === 'build' || entry.name === 'node_modules') continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (
				entry.isFile() &&
				(entry.name.endsWith('.move') ||
					entry.name === 'Move.toml' ||
					entry.name === 'Move.lock')
			) {
				const stat = await fs.stat(full);
				if (stat.mtimeMs > max) max = stat.mtimeMs;
			}
		}
	};
	await walk(root);
	return max;
}

/** Return a `BindingsEmitter` plug-in instance. Pass into
 *  `Codegen({ emitters: [BindingsEmitter()] })` or a per-Package
 *  emitter override. */
export const BindingsEmitter = (opts: BindingsEmitterOptions = {}): Emitter => {
	const importExtension = opts.importExtension ?? '.ts';
	return defineEmitter({
		name: 'bindings',
		emit: (ctx) => runEmit(ctx, importExtension),
	});
};
