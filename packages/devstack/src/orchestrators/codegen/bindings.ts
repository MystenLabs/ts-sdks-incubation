// Move-package bindings emission.
//
// Distilled-doc § "Move-to-TS bindings: per-published-package typed
// client modules produced from each local Move package's summary."
// Calls `@mysten/codegen`'s `generateFromPackageSummary` against the
// `sui move summary` JSON for each LOCAL package.
//
// sourcePath-known-vs-unknown discipline:
//   - `Package` plugin's `Codegenable` emits a `PackageBindings`
//     shape with `sourcePath: string | null`.
//   - The bindings emitter filters to `sourcePath !== null` (i.e.
//     LOCAL packages); `KnownPackage` entries (`sourcePath: null`)
//     are skipped — their bindings come from the SDK or MVR.
//
// Architecture seam:
//   - The production layer runs `sui move summary` through the
//     container runtime's Sui CLI image. Tests and embedders can
//     replace `MoveSummaryRunnerService` through normal Layer
//     composition; no harness-only path exists.
//   - The call to `@mysten/codegen.generateFromPackageSummary` is
//     similarly behind a tagged service so unit tests can stub it
//     without pulling in the heavyweight `@mysten/codegen` graph.
//
// Distilled-doc § "Silent no-op from a downstream tool is a
// failure": after summary + render, we probe the output dir.
// If it's empty, that's a `CodegenBindingsFailed` with a hint about
// the common `Move.toml` `[addresses]` cause.

import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

import { generateFromPackageSummary } from '@mysten/codegen';
import { Context, Effect, FileSystem, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { capture } from '../../substrate/runtime/observability/subprocess-capture.ts';
import {
	shellQuote,
	suiCliImageBuildContext,
} from '../../substrate/runtime/sui-move-build/index.ts';

import { emitOne } from './emit.ts';
import { CodegenBindingsFailed } from './errors.ts';
import { NON_SENSITIVE_FILE_MODE } from './permissions.ts';

// -----------------------------------------------------------------------------
// Service seam — Move summary + codegen invocation
// -----------------------------------------------------------------------------

/** Result of `sui move summary` — opaque JSON the codegen generator
 *  consumes. We don't decode it here; `@mysten/codegen` owns the
 *  schema. */
export interface MoveSummary {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly summaryPath?: string;
	readonly cleanupPath?: string;
	readonly summaryJson: unknown;
}

export interface MoveSummaryInput {
	readonly packageName: string;
	readonly sourcePath: string;
	readonly buildImage?: ImageRef | null;
}

/** Shape of the Move summary runner. Implementations:
 *   - `dockerMoveSummary` — the `ContainerRuntime.runOneShot` path.
 *   - `hostMoveSummary` — the fallback host-binary path.
 *   - `stubMoveSummary` — used in tests (returns a fixture). */
export interface MoveSummaryRunner {
	readonly runSummary: (
		input: MoveSummaryInput,
	) => Effect.Effect<MoveSummary, CodegenBindingsFailed>;
}

export class MoveSummaryRunnerService extends Context.Service<
	MoveSummaryRunnerService,
	MoveSummaryRunner
>()('@devstack-rewrite/orchestrator/MoveSummaryRunner') {}

/** Shape of the `@mysten/codegen` invocation. Returns the rendered
 *  TS files (path → content) for one package. */
export interface MoveCodegen {
	readonly generate: (input: {
		readonly packageName: string;
		readonly sourcePath: string;
		readonly summary: MoveSummary;
		readonly mvrPlaceholder: string;
		readonly importExtension: '.ts' | '.js' | '';
	}) => Effect.Effect<
		ReadonlyArray<{ readonly relPath: string; readonly content: string }>,
		CodegenBindingsFailed
	>;
}

export class MoveCodegenService extends Context.Service<MoveCodegenService, MoveCodegen>()(
	'@devstack-rewrite/orchestrator/MoveCodegen',
) {}

// -----------------------------------------------------------------------------
// Public entry — emit bindings for the local packages in a set of
// PackageBindings contributions.
// -----------------------------------------------------------------------------

export interface PackageBindings {
	readonly name: string;
	readonly packageId: string;
	readonly mvrPlaceholder: string;
	readonly sourcePath: string | null;
	readonly excluded: boolean;
}

export interface EmitBindingsInput {
	readonly bindingsDir: string;
	readonly packages: ReadonlyArray<PackageBindings>;
	readonly importExtension?: '.ts' | '.js' | '';
}

export interface EmitBindingsResult {
	readonly packagesEmitted: ReadonlyArray<string>;
	readonly packagesSkipped: ReadonlyArray<string>;
	readonly filesWritten: ReadonlyArray<string>;
}

/**
 * Walk the `PackageBindings` set, filter to LOCAL packages
 * (`sourcePath !== null`), run `sui move summary` + `@mysten/codegen`
 * for each, and write the rendered files into `bindingsDir/<name>/`.
 *
 * Serial within a cycle (distilled-doc § "Serial within a cycle":
 * shared Move build cache races). Per-package parallelism is unsafe.
 */
export const emitBindings = (
	input: EmitBindingsInput,
): Effect.Effect<
	EmitBindingsResult,
	CodegenBindingsFailed,
	FileSystem.FileSystem | MoveSummaryRunnerService | MoveCodegenService
> =>
	Effect.gen(function* () {
		const runner = yield* MoveSummaryRunnerService;
		const generator = yield* MoveCodegenService;
		const importExtension = input.importExtension ?? '.ts';

		// Dedup by package name. First-wins; distilled-doc § "Duplicate
		// package names": warn + skip the duplicate to avoid the HMR
		// re-emit storm.
		const seen = new Set<string>();
		const targets: Array<PackageBindings> = [];
		const skipped: Array<string> = [];
		for (const pkg of input.packages) {
			if (pkg.sourcePath === null) {
				skipped.push(pkg.name);
				continue;
			}
			if (pkg.excluded) {
				skipped.push(pkg.name);
				continue;
			}
			if (seen.has(pkg.name)) {
				yield* Effect.logWarning(
					`codegen.bindings: duplicate package name '${pkg.name}' — keeping ` +
						`first and skipping duplicate to avoid HMR re-emit storm. ` +
						`Rename one of the packages.`,
				);
				skipped.push(pkg.name);
				continue;
			}
			seen.add(pkg.name);
			targets.push(pkg);
		}
		// Deterministic order: lexicographic by package name.
		targets.sort((a, b) => a.name.localeCompare(b.name));

		const emitted: Array<string> = [];
		const filesWritten: Array<string> = [];
		for (const pkg of targets) {
			// sourcePath is non-null per the filter above. Narrow.
			if (pkg.sourcePath === null) continue;
			const summary = yield* runner.runSummary({
				packageName: pkg.name,
				sourcePath: pkg.sourcePath,
			});
			const files = yield* generator.generate({
				packageName: pkg.name,
				sourcePath: pkg.sourcePath,
				summary,
				mvrPlaceholder: pkg.mvrPlaceholder,
				importExtension,
			});
			// Post-emit probe — silent no-op detection.
			if (files.length === 0) {
				return yield* Effect.fail(
					new CodegenBindingsFailed({
						package: pkg.name,
						sourcePath: pkg.sourcePath,
						reason: 'no-output',
						hint:
							'The Move codegen generator produced no files. This is ' +
							'usually caused by a missing `[addresses]` block in the ' +
							"package's Move.toml, or a non-published address mapping.",
					}),
				);
			}
			for (const f of files) {
				if (f.relPath.includes('..') || f.relPath.startsWith('/')) {
					return yield* Effect.fail(
						new CodegenBindingsFailed({
							package: pkg.name,
							sourcePath: pkg.sourcePath,
							reason: 'write-failed',
							cause: new Error(`generated binding path escapes output dir: ${f.relPath}`),
						}),
					);
				}
				const abs = joinPath(input.bindingsDir, f.relPath);
				const outcome = yield* emitOne({
					path: abs,
					content: f.content,
					mode: NON_SENSITIVE_FILE_MODE,
				}).pipe(
					Effect.mapError(
						(cause) =>
							new CodegenBindingsFailed({
								package: pkg.name,
								sourcePath: pkg.sourcePath!,
								reason: 'write-failed',
								cause,
							}),
					),
				);
				if (outcome.outcome !== 'unchanged') {
					filesWritten.push(abs);
				}
			}
			emitted.push(pkg.name);
		}

		return {
			packagesEmitted: emitted,
			packagesSkipped: skipped,
			filesWritten,
		};
	}).pipe(
		Effect.withSpan('codegen.emitBindings', {
			attributes: { 'codegen.bindingsDir': input.bindingsDir },
		}),
	);

// -----------------------------------------------------------------------------
// Stub implementations for tests
// -----------------------------------------------------------------------------

/** Stub runner — returns a synthetic summary. Used in unit tests
 *  to exercise the bindings pipeline without a real `sui` binary. */
export const stubMoveSummaryRunner = (
	summaryFor: (sourcePath: string) => MoveSummary,
): MoveSummaryRunner => ({
	runSummary: ({ sourcePath }) => Effect.succeed(summaryFor(sourcePath)),
});

/** Stub generator — returns a synthetic file set. Used in unit
 *  tests to exercise the bindings pipeline without pulling in the
 *  heavyweight `@mysten/codegen` graph. */
export const stubMoveCodegen = (
	files: (
		input: Parameters<MoveCodegen['generate']>[0],
	) => ReadonlyArray<{ readonly relPath: string; readonly content: string }>,
): MoveCodegen => ({
	generate: (input) => Effect.succeed(files(input)),
});

// -----------------------------------------------------------------------------
// Production implementations
// -----------------------------------------------------------------------------

export const layerDockerMoveSummaryRunner: Layer.Layer<
	MoveSummaryRunnerService,
	never,
	ContainerRuntimeService
> = Layer.effect(
	MoveSummaryRunnerService,
	Effect.gen(function* () {
		const runtime: ContainerRuntime = yield* ContainerRuntimeService;
		return MoveSummaryRunnerService.of({
			runSummary: (input) => runSummaryViaDocker(runtime, input),
		});
	}),
);

export const layerHostMoveSummaryRunner: Layer.Layer<
	MoveSummaryRunnerService,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
	MoveSummaryRunnerService,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		return MoveSummaryRunnerService.of({
			runSummary: ({ packageName, sourcePath }) =>
				Effect.gen(function* () {
					const scratchDir = yield* Effect.tryPromise({
						try: () => mkdtemp(join(tmpdir(), 'devstack-move-summary-')),
						catch: (cause) =>
							new CodegenBindingsFailed({
								package: packageName,
								sourcePath,
								reason: 'summary-failed',
								hint: 'Unable to create a temporary directory for Move summary output.',
								cause,
							}),
					});
					const summaryPath = join(scratchDir, 'package');
					const cleanupScratch = Effect.promise(() =>
						rm(scratchDir, { recursive: true, force: true }),
					).pipe(Effect.ignore);
					const result = yield* Effect.gen(function* () {
						yield* Effect.tryPromise({
							try: async () => {
								await mkdir(summaryPath, { recursive: true });
								await copyFile(join(sourcePath, 'Move.toml'), join(summaryPath, 'Move.toml'));
							},
							catch: (cause) =>
								new CodegenBindingsFailed({
									package: packageName,
									sourcePath,
									reason: 'summary-failed',
									hint: 'Unable to prepare a temporary Move summary package directory.',
									cause,
								}),
						});
						const cmd = ChildProcess.make(
							'sui',
							[
								'move',
								'summary',
								'--path',
								'.',
								'--install-dir',
								join(scratchDir, 'install'),
								'--output-directory',
								join(summaryPath, 'package_summaries'),
							],
							{ cwd: sourcePath },
						);
						return yield* capture(spawner, cmd, {
							op: `sui move summary (${sourcePath})`,
							nonZeroIsFailure: true,
							stdoutTruncate: Infinity,
							stderrTruncate: 4_000,
						}).pipe(
							Effect.mapError(
								(cause) =>
									new CodegenBindingsFailed({
										package: packageName,
										sourcePath,
										reason: 'summary-failed',
										hint: 'Install the Sui CLI and ensure this Move package can run `sui move summary`.',
										cause,
									}),
							),
						);
					}).pipe(Effect.tapError(() => cleanupScratch));
					return {
						packageName,
						sourcePath,
						summaryPath,
						cleanupPath: scratchDir,
						summaryJson: parseSummaryStdout(result.stdout),
					};
				}),
		});
	}),
);

const runSummaryViaDocker = (
	runtime: ContainerRuntime,
	input: MoveSummaryInput,
): Effect.Effect<MoveSummary, CodegenBindingsFailed> =>
	Effect.scoped(
		Effect.gen(function* () {
			const scratchDir = yield* makeSummaryScratch(input);
			const summaryPath = join(scratchDir, 'package');
			const cleanupScratch = Effect.promise(() =>
				rm(scratchDir, { recursive: true, force: true }),
			).pipe(Effect.ignore);
			const result = yield* Effect.gen(function* () {
				yield* prepareSummaryPackage(summaryPath, input);
				const image = input.buildImage ?? (yield* resolveDefaultSummaryImage(runtime, input));
				const moveHome = join(homedir(), '.move');
				yield* ensureMoveHome(moveHome, input);
				const packageRoot = dirname(input.sourcePath);
				const packageDir = basename(input.sourcePath);
				const hostUid = typeof process.getuid === 'function' ? process.getuid() : 0;
				const hostGid = typeof process.getgid === 'function' ? process.getgid() : 0;
				const command = [
					'set -e',
					'cleanup_summary() { status=$?; ' +
						'chmod -R a+rwX /summary 2>/dev/null || true; ' +
						`chown -R ${hostUid}:${hostGid} /summary 2>/dev/null || true; ` +
						'exit "$status"; }',
					'trap cleanup_summary EXIT',
					'mkdir -p /summary/package_summaries',
					`sui move summary --path /workspace/${shellQuote(packageDir)} ` +
						'--install-dir /tmp/devstack-move-summary-install ' +
						'--output-directory /summary/package_summaries',
				].join('; ');
				const run = yield* runtime
					.runOneShot({
						image,
						entrypoint: 'sh',
						argv: ['-c', command],
						mounts: [
							{ source: packageRoot, target: '/workspace' },
							{ source: summaryPath, target: '/summary' },
							{ source: moveHome, target: '/root/.move' },
						],
						timeoutMillis: 5 * 60_000,
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new CodegenBindingsFailed({
									package: input.packageName,
									sourcePath: input.sourcePath,
									reason: 'summary-failed',
									hint: 'Docker runtime failed while running `sui move summary` for bindings codegen.',
									cause,
								}),
						),
					);
				if (run.exitCode !== 0) {
					return yield* Effect.fail(
						new CodegenBindingsFailed({
							package: input.packageName,
							sourcePath: input.sourcePath,
							reason: 'summary-failed',
							hint:
								`sui move summary exited ${run.exitCode}. ` +
								`stderr: ${run.stderr || '(empty)'}; stdout tail: ${
									run.stdout.slice(-400) || '(empty)'
								}`,
						}),
					);
				}
				return run;
			}).pipe(Effect.tapError(() => cleanupScratch));
			return {
				packageName: input.packageName,
				sourcePath: input.sourcePath,
				summaryPath,
				cleanupPath: scratchDir,
				summaryJson: parseSummaryStdout(result.stdout),
			};
		}),
	);

const makeSummaryScratch = (
	input: MoveSummaryInput,
): Effect.Effect<string, CodegenBindingsFailed> =>
	Effect.tryPromise({
		try: () => mkdtemp(join(tmpdir(), 'devstack-move-summary-')),
		catch: (cause) =>
			new CodegenBindingsFailed({
				package: input.packageName,
				sourcePath: input.sourcePath,
				reason: 'summary-failed',
				hint: 'Unable to create a temporary directory for Move summary output.',
				cause,
			}),
	});

const prepareSummaryPackage = (
	summaryPath: string,
	input: MoveSummaryInput,
): Effect.Effect<void, CodegenBindingsFailed> =>
	Effect.tryPromise({
		try: async () => {
			await mkdir(summaryPath, { recursive: true });
			await copyFile(join(input.sourcePath, 'Move.toml'), join(summaryPath, 'Move.toml'));
		},
		catch: (cause) =>
			new CodegenBindingsFailed({
				package: input.packageName,
				sourcePath: input.sourcePath,
				reason: 'summary-failed',
				hint: 'Unable to prepare a temporary Move summary package directory.',
				cause,
			}),
	});

const resolveDefaultSummaryImage = (
	runtime: ContainerRuntime,
	input: MoveSummaryInput,
): Effect.Effect<ImageRef, CodegenBindingsFailed> =>
	runtime.ensureImage(suiCliImageBuildContext()).pipe(
		Effect.mapError(
			(cause) =>
				new CodegenBindingsFailed({
					package: input.packageName,
					sourcePath: input.sourcePath,
					reason: 'summary-failed',
					hint: 'Unable to resolve the Sui CLI container image for Move bindings codegen.',
					cause,
				}),
		),
	);

const ensureMoveHome = (
	moveHome: string,
	input: MoveSummaryInput,
): Effect.Effect<void, CodegenBindingsFailed> =>
	Effect.tryPromise({
		try: () => mkdir(moveHome, { recursive: true }),
		catch: (cause) =>
			new CodegenBindingsFailed({
				package: input.packageName,
				sourcePath: input.sourcePath,
				reason: 'summary-failed',
				hint: `Unable to create Move cache mount source "${moveHome}".`,
				cause,
			}),
	}).pipe(Effect.asVoid);

export const layerMystenMoveCodegen: Layer.Layer<MoveCodegenService> = Layer.succeed(
	MoveCodegenService,
	MoveCodegenService.of({
		generate: (input) =>
			Effect.tryPromise({
				try: async () => {
					const tmp = await mkdtemp(join(tmpdir(), 'devstack-move-codegen-'));
					try {
						await generateFromPackageSummary({
							package: {
								path: input.summary.summaryPath ?? input.sourcePath,
								package: input.mvrPlaceholder,
								packageName: input.packageName,
							},
							prune: true,
							outputDir: tmp,
							importExtension: input.importExtension,
						});
						return await collectGeneratedFiles(tmp);
					} finally {
						await rm(tmp, { recursive: true, force: true });
						if (input.summary.cleanupPath !== undefined) {
							await rm(input.summary.cleanupPath, { recursive: true, force: true });
						}
					}
				},
				catch: (cause) =>
					new CodegenBindingsFailed({
						package: input.packageName,
						sourcePath: input.sourcePath,
						reason: 'render-failed',
						cause,
					}),
			}),
	}),
);

// -----------------------------------------------------------------------------
// Local helpers — keep the module dep-free of Path.Path so the
// caller can compose without an extra service yield.
// -----------------------------------------------------------------------------

const joinPath = (...parts: ReadonlyArray<string>): string =>
	parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/');

const parseSummaryStdout = (stdout: string): unknown => {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return null;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return trimmed;
	}
};

const collectGeneratedFiles = async (
	root: string,
): Promise<ReadonlyArray<{ readonly relPath: string; readonly content: string }>> => {
	const out: Array<{ readonly relPath: string; readonly content: string }> = [];
	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const relPath = relative(root, abs).split(sep).join('/');
			out.push({ relPath, content: await readFile(abs, 'utf8') });
		}
	};
	await walk(root);
	out.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return out;
};
