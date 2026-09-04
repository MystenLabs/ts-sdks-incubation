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
//     wiring (`orchestrators/boot.ts`).
//   - `layerSuiMoveSummaryRunnerHost` — runs the local `sui`
//     binary directly via `ChildProcessSpawner`. Useful for
//     embedders that already have a Sui CLI on PATH.

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { Effect, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import type { ContainerRuntime, ImageRef } from '../../contracts/container-runtime.ts';
import type { MoveToolchain } from '../../contracts/codegenable.ts';
import {
	type MoveSummary,
	type MoveSummaryInput,
	MoveSummaryRunnerService,
} from '../../orchestrators/codegen/bindings.ts';
import { CodegenBindingsFailed } from '../../orchestrators/codegen/errors.ts';
import { ContainerRuntimeService } from '../../runtime/docker/service.ts';
import { capture } from '../../substrate/runtime/observability/subprocess-capture.ts';
import {
	copyLocalMoveDeps,
	DEFAULT_SUI_TOOLS_REF,
	shellQuote,
	suiCliImageBuildContext,
	suiToolsImage,
} from './move/index.ts';

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

/** A minimal, DISPOSABLE sui client config. `sui move summary` initialises a
 *  client config on first use and PROMPTS ("No sui config found, create one
 *  [Y/n]?") when none exists — which blocks forever on a non-interactive stdin
 *  (e.g. CI), hanging codegen. Pointing `SUI_CONFIG_DIR` at a pre-seeded config
 *  inside the per-run scratch dir sidesteps the prompt without touching the
 *  developer's real `~/.sui`. The summary is an OFFLINE build (framework deps
 *  are embedded in the CLI), so we write the SMALLEST config the CLI parser
 *  accepts: a keystore path and an EMPTY env list. No network env at all — the
 *  `keystore` + `envs` fields are required by the parser, but no `rpc` is ever
 *  contacted. */
const disposableSuiClientConfig = (configDir: string): string =>
	[
		'---',
		'keystore:',
		`  File: ${join(configDir, 'sui.keystore')}`,
		'envs: []',
		'active_env: ~',
		'active_address: ~',
		'',
	].join('\n');

/** The host runner runs whatever `sui` is on PATH, so it cannot honour a
 *  toolchain the stack pinned. Say so — once per summary — when the pin was
 *  explicit (config or env) or is an exact live image; devstack's own
 *  default pin is not worth a warning. */
const warnIfHostCannotHonour = (toolchain: MoveToolchain | undefined): Effect.Effect<void> => {
	if (toolchain === undefined || (toolchain.kind === 'sui-tools' && !toolchain.explicit)) {
		return Effect.void;
	}
	const pinned =
		toolchain.kind === 'image'
			? `image ${toolchain.image.tag ?? toolchain.image.digest}`
			: suiToolsImage(toolchain.suiToolsRef);
	return Effect.logWarning(
		'codegen: running `sui move summary` with the host `sui` CLI, but the stack pins its ' +
			`toolchain to ${pinned}, which this path cannot use. Bindings may differ from what the ` +
			'stack publishes with; install a matching CLI (e.g. `suiup install sui@<version>`) ' +
			'or run codegen through a stack boot.',
	);
};

export const layerSuiMoveSummaryRunnerHost: Layer.Layer<
	MoveSummaryRunnerService,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
	MoveSummaryRunnerService,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		return MoveSummaryRunnerService.of({
			runSummary: ({ packageName, sourcePath, moveToolchain }) =>
				Effect.gen(function* () {
					yield* warnIfHostCannotHonour(moveToolchain);
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
					// Run summary inside a disposable copy of the package, never the
					// developer's real source — `sui move summary` rewrites Move.lock.
					const stagedPkg = join(scratchDir, 'src');
					// Disposable sui config dir so the CLI never prompts to create one
					// (see `disposableSuiClientConfig`). Passed via `SUI_CONFIG_DIR`.
					const suiConfigDir = join(scratchDir, 'sui-config');
					const cleanupScratch = Effect.promise(() =>
						rm(scratchDir, { recursive: true, force: true }),
					).pipe(Effect.ignore);
					const result = yield* Effect.gen(function* () {
						yield* Effect.tryPromise({
							try: async () => {
								await mkdir(summaryPath, { recursive: true });
								await cp(sourcePath, stagedPkg, { recursive: true });
								// Stage local relative deps so `sui move summary` resolves them.
								await copyLocalMoveDeps(sourcePath, stagedPkg, dirname(stagedPkg));
								// Place the source manifest beside the emitted summary: it
								// is the dir we hand `@mysten/codegen`, which reads
								// `Move.toml` there for its `[addresses]` labels. Without
								// it the library logs "Failed to read Move.toml for <dir>"
								// and falls back to `packageName`; with it the read
								// succeeds (warning gone) and its native main-package
								// resolution works. Best-effort — a manifest-less source
								// just keeps the prior fallback.
								await cp(join(sourcePath, 'Move.toml'), join(summaryPath, 'Move.toml')).catch(
									() => {},
								);
								// Pre-seed the disposable sui config so the CLI never prompts.
								await mkdir(suiConfigDir, { recursive: true });
								await writeFile(join(suiConfigDir, 'sui.keystore'), '[]');
								await writeFile(
									join(suiConfigDir, 'client.yaml'),
									disposableSuiClientConfig(suiConfigDir),
								);
							},
							catch: (cause) =>
								new CodegenBindingsFailed({
									package: packageName,
									sourcePath,
									reason: 'summary-failed',
									hint: 'Unable to stage a disposable copy of the Move package for summary.',
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
							{ cwd: stagedPkg, env: { SUI_CONFIG_DIR: suiConfigDir }, extendEnv: true },
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
				const image = yield* resolveSummaryImage(runtime, input);
				const moveHome = join(homedir(), '.move');
				yield* ensureMoveHome(moveHome, input);
				const packageDir = basename(input.sourcePath);
				// Mount a disposable staged copy at /workspace, never the real source
				// tree — `sui move summary` rewrites Move.lock during resolution.
				const stagedRoot = join(scratchDir, 'src');
				yield* stageSummarySource(input, join(stagedRoot, packageDir));
				const hostUid = typeof process.getuid === 'function' ? process.getuid() : 0;
				const hostGid = typeof process.getgid === 'function' ? process.getgid() : 0;
				const command = [
					'set -e',
					'cleanup_summary() { status=$?; ' +
						'chmod -R a+rwX /summary /workspace 2>/dev/null || true; ' +
						`chown -R ${hostUid}:${hostGid} /summary /workspace 2>/dev/null || true; ` +
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
							{ source: stagedRoot, target: '/workspace' },
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
		// Only create the OUTPUT mount dir; the package itself is mounted from a
		// disposable staged copy (see `stageSummarySource`), never the real source.
		// Also drop in the source manifest so the host-side `@mysten/codegen` reads
		// its `[addresses]` from this dir (see `layerSuiMoveSummaryRunnerHost`) —
		// silences the "Failed to read Move.toml" warning. Best-effort.
		try: async () => {
			await mkdir(summaryPath, { recursive: true });
			await cp(join(input.sourcePath, 'Move.toml'), join(summaryPath, 'Move.toml')).catch(() => {});
		},
		catch: (cause) =>
			new CodegenBindingsFailed({
				package: input.packageName,
				sourcePath: input.sourcePath,
				reason: 'summary-failed',
				hint: 'Unable to prepare a temporary Move summary output directory.',
				cause,
			}),
	});

// Stage a disposable copy of the Move package. `sui move summary` rewrites
// `Move.lock` during dependency resolution, so running it against the
// developer's real checked-in tree would dirty their working copy. The copy
// lives under the scoped scratch dir and is reaped with it.
const stageSummarySource = (
	input: MoveSummaryInput,
	stagedPkg: string,
): Effect.Effect<void, CodegenBindingsFailed> =>
	Effect.tryPromise({
		try: async () => {
			await mkdir(dirname(stagedPkg), { recursive: true });
			await cp(input.sourcePath, stagedPkg, { recursive: true });
			// Bring local `../` deps (`{ local = "../token" }`) into the staged
			// tree so `sui move summary` resolves them (mirrors the build path).
			await copyLocalMoveDeps(input.sourcePath, stagedPkg, dirname(stagedPkg));
		},
		catch: (cause) =>
			new CodegenBindingsFailed({
				package: input.packageName,
				sourcePath: input.sourcePath,
				reason: 'summary-failed',
				hint: 'Unable to stage a disposable copy of the Move package for summary.',
				cause,
			}),
	});

/** The image `sui move summary` runs in. An `image` toolchain is used as
 *  is — the very image the stack built/publishes with. A `sui-tools`
 *  toolchain (stack-free codegen, derived from the mode's image plan)
 *  builds the shared CLI image on that ref. No toolchain means devstack's
 *  bundled pin. The env var is NOT consulted here: the sui plugin folds it
 *  into the plan, so config and env keep one precedence everywhere. */
const resolveSummaryImage = (
	runtime: ContainerRuntime,
	input: MoveSummaryInput,
): Effect.Effect<ImageRef, CodegenBindingsFailed> => {
	const toolchain = input.moveToolchain;
	if (toolchain?.kind === 'image') {
		return Effect.succeed(toolchain.image);
	}
	const suiToolsRef =
		toolchain?.kind === 'sui-tools' ? toolchain.suiToolsRef : DEFAULT_SUI_TOOLS_REF;
	// Shared CLI image — owned at the daemon-level _per-app_ pin (see
	// `chain-build-container.ts:PER_APP_SHARED_STACK`), not per-stack;
	// the build container that materialises it carries the labels, so
	// `ensureImage` itself is intentionally label-free here.
	return runtime.ensureImage(suiCliImageBuildContext(suiToolsRef)).pipe(
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
};

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
