// Sui plugin — Move-summary runner Layer factories.
//
// The codegen orchestrator (L3) consumes an abstract
// `MoveSummaryRunnerService`; it does NOT know which CLI image or
// host binary produces the summary JSON. Both production
// implementations live here because they encode Sui-specific
// knowledge (the `sui` binary name, the Sui CLI image, the
// `sui move summary` argv shape).
//
// Architecture: per "Orchestrator boundaries — never names a
// service", the codegen orchestrator imports only the abstract
// `MoveSummaryRunnerService` from its `bindings.ts`; the runtime
// composer wires one of these sui-plugin layers in.
//
// Implementations:
//   - `layerSuiMoveSummaryRunnerDocker` — runs `sui move summary`
//     inside the Sui CLI container image; the default production
//     wiring (`runtime-composition.ts`).
//   - `layerSuiMoveSummaryRunnerHost` — runs the local `sui`
//     binary directly via `ChildProcessSpawner`. Useful for
//     embedders that already have a Sui CLI on PATH.

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { Effect, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import {
	type MoveSummary,
	type MoveSummaryInput,
	MoveSummaryRunnerService,
} from '../../orchestrators/codegen/bindings.ts';
import { CodegenBindingsFailed } from '../../orchestrators/codegen/errors.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { capture } from '../../substrate/runtime/observability/subprocess-capture.ts';
import {
	shellQuote,
	suiCliImageBuildContext,
} from '../../substrate/runtime/sui-move-build/index.ts';

// -----------------------------------------------------------------------------
// Docker variant — `sui move summary` inside the Sui CLI container image.
// -----------------------------------------------------------------------------

export const layerSuiMoveSummaryRunnerDocker: Layer.Layer<
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

// -----------------------------------------------------------------------------
// Host-binary variant — invoke a `sui` CLI on PATH directly.
// -----------------------------------------------------------------------------

export const layerSuiMoveSummaryRunnerHost: Layer.Layer<
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

// -----------------------------------------------------------------------------
// Docker-variant helpers — shared with `runSummaryViaDocker`.
// -----------------------------------------------------------------------------

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

const parseSummaryStdout = (stdout: string): unknown => {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return null;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return trimmed;
	}
};
