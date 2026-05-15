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

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { generateFromPackageSummary } from '@mysten/codegen';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { CodegenError } from '../errors.js';
import { defineEmitter, type CodegenContext, type Emitter } from '../define-emitter.js';

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

		const staging = `${outputAbs}.staging-${process.pid}`;

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

		const codegen = Effect.forEach(
			targets,
			(t) =>
				Effect.gen(function* () {
					yield* Effect.annotateCurrentSpan({ 'bindings.target': t.name });
					yield* Effect.logInfo(`sui move summary -> ${t.name}`);
					const summaryCmd = ChildProcess.make('sui', ['move', 'summary'], {
						cwd: t.sourcePath,
					});
					yield* spawner.exitCode(summaryCmd).pipe(
						Effect.mapError(
							(cause) =>
								new CodegenError({
									emitter: 'bindings',
									phase: 'generate',
									message: `${t.name}: sui move summary failed: ${stringifyCause(cause)}`,
									cause,
								}),
						),
					);
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
	});

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
