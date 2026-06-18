// `devstack codegen` verb wiring.
//
// Deterministic, STACK-FREE codegen: `(Move source) → generated`. It
// boots NO stack and uses NO Docker — the `sui move summary` step runs
// against a host `sui` CLI on PATH, which is REQUIRED: codegen fails fast
// with an actionable error when `sui` is absent (rather than silently
// pulling a Docker image). The detected `sui --version` is logged so the
// build that produced the committed tree is visible; CI installs a pinned
// `sui` and the drift-guard catches any version-skew in the output. It
// loads the config, derives each plugin's codegen contributions from config
// ALONE (via the plugin spec's `staticCodegen` hook), and runs ONE
// `runEmitCycle` that writes the committed `src/generated` tree.
//
// On-chain ids are LOADED CONFIG DATA, not generated output. The
// committed tree carries the all-zero sentinel for every LOCAL id (and
// declared literals for KNOWN packages); the committed `config.ts`
// resolver throws loudly at runtime if a sentinel id is used. The Vite
// plugin injects the real ids in dev (live `devstack-ids.json`) and prod
// (a committed id-config file via the `ids` option / `DEVSTACK_IDS_FILE`).
// So `git status` shows NO churn under
// `src/generated` after a `devstack up` — ids land only in the
// gitignored `.devstack/`.
//
// Logger layer: `Logger.consolePretty()` — mirrors `apply.ts` exactly.
// `consolePretty` needs no FileSystem, so it is provided as a separate
// OUTER layer over the codegen service layer (which provides the Node
// FileSystem / Path / child-process spawner UNDER the codegen services).
// This is the same provision shape `apply` uses and compiles cleanly
// under the strict tsconfig.

import { spawnSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';

import { Cause, Effect, Exit, Layer, Logger } from 'effect';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import type { CodegenableDecl } from '../../contracts/codegenable.ts';
import type { AnyPlugin } from '../../substrate/plugin.ts';
import type { SupervisedStack } from '../../substrate/runtime/index.ts';
import { layerMystenMoveCodegen } from '../../orchestrators/codegen/bindings.ts';
import { layerSuiMoveSummaryRunnerHost } from '../../plugins/sui/move-summary-runner.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../orchestrators/codegen/service.ts';
import { type CliError, CliInternalError, CliUnavailableError } from '../../surfaces/cli/errors.ts';
import { type CommandResult } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeConfigLoader } from './config-loader.ts';

/** Walk the stack members, calling each plugin spec's `staticCodegen`
 *  hook (skipping plugins that lack one) to derive the committed-tree
 *  contributions from config alone. KNOWN package ids come from the
 *  declared `networks` literals; LOCAL ids stay the all-zero sentinel
 *  (resolved at app build/dev time through `__DEVSTACK_IDS__`). */
export const deriveContributions = (
	members: ReadonlyArray<AnyPlugin>,
): ReadonlyArray<CodegenableDecl> => {
	const decls: Array<CodegenableDecl> = [];
	for (const member of members) {
		if (member.staticCodegen === undefined) continue;
		decls.push(...member.staticCodegen());
	}
	return decls;
};

/** Probe the host `sui` CLI with a cheap `--version` call. Returns the
 *  trimmed version line on success (e.g. `sui 1.39.0-abcdef0`), or `null`
 *  when no `sui` is resolvable on PATH (missing binary, non-zero exit, or
 *  spawn failure). The version is surfaced in codegen output so the build
 *  that produced the committed tree is visible. */
const probeHostSui = (): string | null => {
	try {
		const probe = spawnSync('sui', ['--version'], { timeout: 5_000, encoding: 'utf8' });
		if (probe.status !== 0) return null;
		const line = (probe.stdout ?? '').trim() || (probe.stderr ?? '').trim();
		return line.length > 0 ? line : 'sui (version unknown)';
	} catch {
		return null;
	}
};

/**
 * Build the codegen service layer: `CodegenPathsService` +
 * `MoveSummaryRunnerService` + `MoveCodegenService`, with the Node
 * FileSystem / Path / child-process spawner provided UNDER them. Mirrors
 * `apply`'s substrate-layer provision shape — one merged layer providing
 * the services, with `Logger` supplied as a separate outer layer over the
 * program (`consolePretty` needs no FileSystem).
 *
 * The Move-summary runner is the HOST runner — it invokes the `sui` CLI on
 * PATH and only needs a child-process spawner (no Docker, no substrate
 * layer stack). The caller guarantees `sui` is present (see `runCodegen`).
 */
const buildCodegenLayer = (appRoot: string) => {
	const generatedDir = resolvePath(appRoot, 'src', 'generated');
	const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
	const codegenPaths = layerCodegenPaths.pipe(
		Layer.provideMerge(
			layerCodegenRoot({
				outputDir: generatedDir,
				stackSubdir: null,
				// Static contributions never target `generated-extras` (those
				// decls are dev-only and carry no `staticCodegen`), so this
				// path is declared but never written.
				extrasDir: resolvePath(appRoot, 'src', 'generated-extras'),
			}),
		),
	);
	const moveRunner = layerSuiMoveSummaryRunnerHost.pipe(
		Layer.provideMerge(NodeChildProcessSpawner.layer),
	);
	return Layer.mergeAll(codegenPaths, moveRunner, layerMystenMoveCodegen()).pipe(
		Layer.provideMerge(platform),
	);
};

/**
 * Run the stack-free codegen verb. `configPath` is the devstack config
 * path. No stack boots; the committed `src/generated` tree is rewritten
 * deterministically from Move source.
 */
export const runCodegen = (
	configPath: string | undefined,
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		// Host `sui` is REQUIRED — the `sui move summary` step has no Docker
		// fallback. Fail fast with an actionable hint when it is missing,
		// rather than emitting an empty/partial tree.
		const suiVersion = probeHostSui();
		if (suiVersion === null) {
			return yield* Effect.fail(
				new CliUnavailableError({
					service: 'sui',
					message:
						'the Sui CLI (`sui`) is required for `devstack codegen` but was not found on PATH',
					hint: 'Install it — https://docs.sui.io/guides/developer/getting-started/sui-install — then re-run `devstack codegen`.',
				}),
			);
		}

		const loadExit = yield* Effect.exit(loader.load(configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const loaded = loadExit.value;
		const stack = (loaded as LoadedConfig & { readonly engine: SupervisedStack }).engine;
		const appRoot = dirname(loaded.resolvedConfigPath);

		const contributions = deriveContributions(stack.members);

		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				yield* Effect.logInfo(`codegen: using host ${suiVersion}`);
				return yield* runEmitCycle({ contributions, trackTree: true });
			}).pipe(
				Effect.provide(buildCodegenLayer(appRoot)),
				Effect.provide(Logger.layer([Logger.consolePretty()])),
			),
		);
		if (Exit.isFailure(exit)) {
			return yield* Effect.fail(
				new CliInternalError({
					message: 'codegen failed',
					cause: Cause.pretty(exit.cause as Cause.Cause<unknown>),
				}),
			);
		}
		return { exitCode: ExitCode.OK };
	});
};
