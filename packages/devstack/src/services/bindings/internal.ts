import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { generateFromPackageSummary } from '@mysten/codegen';
import { tag, setPhase, type Ref } from '../../advanced/tag.js';
import { stringifyCause } from '../../engine/stringify-cause.js';
import { BindingsError } from '../../engine/errors.js';
import type { LocalPackageShape } from '../package.js';

export interface BindingsResult {
	readonly outputPath: string;
	readonly emittedAt: Date;
	readonly targets: ReadonlyArray<string>;
}

export interface BindingsOptions {
	readonly packages: ReadonlyArray<Ref<any, LocalPackageShape, any, any>>;
	readonly output: string;
	readonly importExtension?: '.ts' | '.js' | '';
	readonly name?: string;
}

interface Target {
	readonly name: string;
	readonly path: string;
	readonly mvrPlaceholder: string;
}

// Code-generation primitive: read upstream `publishMove` packages,
// invoke `sui move summary` against each source tree, hand the summary
// to `@mysten/codegen`, and write typed bindings under `output/<name>/`.
//
// Atomic dir swap (stage → rename old aside → rename staging in) so a
// Vite dev server never observes a half-written tree mid-cycle. This
// mirrors the v3 plugin (`packages/devstack/src/plugins/bindings.ts`)
// minus its plugin-engine `getStatus` / `inputs` machinery, which the v4
// runtime models via tag layers and finalizers instead.
/**
 * Generate TypeScript bindings from Move source for one or more
 * locally-deployed packages. Each input package must satisfy
 * `LocalPackageShape` — i.e. it must be a tag produced by `publishMove(...)`
 * (which deploys the package from a local source tree). Tags from
 * `*Known*` factories (e.g. `deepbookKnownPackage`) provide only
 * `PackageShape` and are rejected at compile time, because codegen
 * requires a `sourcePath` to feed `sui move summary` and the package's
 * Move.toml.
 */
export const bindings = (options: BindingsOptions) => {
	const name = options.name ?? 'bindings';
	const importExtension = options.importExtension ?? '.ts';

	return tag(
		`bindings/${name}` as const,
		Effect.fn(`bindings(${name})`)(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			yield* setPhase('reading source');
			// bindings.read — yield each upstream package tag and collect
			// emission targets. Duplicate names (e.g. the same `publishMove`
			// tag listed twice) are deduped so a misconfigured config doesn't
			// invoke `sui move summary` twice for the same tree.
			const targets = yield* Effect.fn('bindings.read')(function* () {
				const out: Array<Target> = [];
				const seen = new Set<string>();
				for (const tag of options.packages) {
					const pkg = yield* tag;
					if (seen.has(pkg.name)) continue;
					seen.add(pkg.name);
					out.push({
						name: pkg.name,
						path: pkg.sourcePath,
						mvrPlaceholder: pkg.mvrPlaceholder,
					});
				}
				return out.sort((a, b) => a.name.localeCompare(b.name));
			})();

			const outputAbs = path.isAbsolute(options.output)
				? options.output
				: path.resolve(process.cwd(), options.output);

			yield* Effect.annotateCurrentSpan({
				'bindings.output': outputAbs,
				'bindings.targetCount': targets.length,
				'bindings.targets': targets.map((t) => t.name).join(','),
			});

			if (targets.length === 0) {
				return {
					outputPath: outputAbs,
					emittedAt: new Date(),
					targets: [] as ReadonlyArray<string>,
				} satisfies BindingsResult;
			}

			yield* setPhase('generating');
			// bindings.codegen — `sui move summary` per target, then hand the
			// generated summary to `@mysten/codegen`. Run targets in parallel:
			// each one is an independent subprocess + fs write into its own
			// subdir of `staging`.
			const staging = `${outputAbs}.staging-${process.pid}`;

			yield* Effect.tryPromise({
				try: () => fs.rm(staging, { recursive: true, force: true }),
				catch: (cause) =>
					new BindingsError({
						phase: 'write',
						message: `bindings: failed to clear staging dir ${staging}: ${stringifyCause(cause)}`,
						cause,
					}),
			});
			yield* Effect.tryPromise({
				try: () => fs.mkdir(staging, { recursive: true }),
				catch: (cause) =>
					new BindingsError({
						phase: 'write',
						message: `bindings: failed to create staging dir ${staging}: ${stringifyCause(cause)}`,
						cause,
					}),
			});

			const codegen = Effect.fn('bindings.codegen')(function* () {
				yield* Effect.forEach(
					targets,
					(t) =>
						Effect.gen(function* () {
							yield* Effect.annotateCurrentSpan({ 'bindings.target': t.name });
							yield* Effect.logInfo(`sui move summary -> ${t.name}`);
							const summaryCmd = ChildProcess.make('sui', ['move', 'summary'], {
								cwd: t.path,
							});
							yield* spawner.exitCode(summaryCmd).pipe(
								Effect.mapError(
									(cause) =>
										new BindingsError({
											phase: 'codegen',
											message: `bindings(${t.name}): sui move summary failed: ${stringifyCause(cause)}`,
											cause,
										}),
								),
							);
							yield* Effect.tryPromise({
								try: () =>
									generateFromPackageSummary({
										package: {
											path: t.path,
											package: t.mvrPlaceholder,
											packageName: t.name,
										},
										prune: true,
										outputDir: staging,
										importExtension,
									}),
								catch: (cause) =>
									new BindingsError({
										phase: 'codegen',
										message: `bindings(${t.name}): codegen failed: ${stringifyCause(cause)}`,
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
									new BindingsError({
										phase: 'codegen',
										message:
											`bindings(${t.name}): generateFromPackageSummary returned without writing ${expected}. ` +
											`Common cause: ${t.name}'s Move.toml is missing an [addresses] block matching the package's summary subdir.`,
									}),
								);
							}
						}),
					{ concurrency: 'unbounded' },
				);
			});

			yield* codegen().pipe(
				Effect.tapError(() =>
					Effect.promise(() => fs.rm(staging, { recursive: true, force: true })),
				),
			);

			yield* setPhase('writing output');
			// bindings.write — promote staging into place via a pair of
			// renames. On codegen failure we clear the staging dir so the
			// next run starts clean; on success we promote it.
			yield* Effect.fn('bindings.write')(function* () {
				const discard = `${outputAbs}.discarding-${process.pid}`;
				yield* Effect.tryPromise({
					try: () => fs.mkdir(path.dirname(outputAbs), { recursive: true }),
					catch: (cause) =>
						new BindingsError({
							phase: 'write',
							message: `bindings: failed to create parent of ${outputAbs}: ${stringifyCause(cause)}`,
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
							new BindingsError({
								phase: 'write',
								message: `bindings: failed to rename existing output aside: ${stringifyCause(cause)}`,
								cause,
							}),
					});
				}
				yield* Effect.tryPromise({
					try: () => fs.rename(staging, outputAbs),
					catch: (cause) =>
						new BindingsError({
							phase: 'write',
							message: `bindings: failed to promote staging into ${outputAbs}: ${stringifyCause(cause)}`,
							cause,
						}),
				});
				yield* Effect.tryPromise({
					try: () => fs.rm(discard, { recursive: true, force: true }),
					catch: () => undefined,
				}).pipe(Effect.ignore({ log: true }));
			})();

			return {
				outputPath: outputAbs,
				emittedAt: new Date(),
				targets: targets.map((t) => t.name),
			} satisfies BindingsResult;
		})(),
		{
			kind: 'action',
			displayTitle: `bindings.${name}`,
			display: (s) => ({
				title: `bindings.${name}`,
				primary: s.outputPath,
				extras: [`${s.targets.length} module${s.targets.length === 1 ? '' : 's'}`],
			}),
		},
	);
};
