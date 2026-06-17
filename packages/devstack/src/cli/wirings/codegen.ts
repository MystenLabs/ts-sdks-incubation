// `devstack codegen` verb wiring.
//
// Deterministic, STACK-FREE codegen: `(Move source) → generated`. It
// boots NO stack — no supervisor, no acquire, no Docker. It loads the
// config, derives each plugin's codegen contributions from config ALONE
// (via the plugin spec's `staticCodegen` hook), and runs ONE
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
import {
	layerSuiMoveSummaryRunnerDocker,
	layerSuiMoveSummaryRunnerHost,
} from '../../plugins/sui/move-summary-runner.ts';
import { buildSubstrateLayers } from '../../orchestrators/boot.ts';
import { layerCodegenPaths, layerCodegenRoot } from '../../orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../orchestrators/codegen/service.ts';
import { type CliError, CliInternalError } from '../../surfaces/cli/errors.ts';
import { type CommandResult } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeConfigLoader } from './config-loader.ts';
import { identityValueFor, type ResolvedIdentity } from './identity.ts';

/** Walk the stack members, calling each plugin spec's `staticCodegen`
 *  hook (skipping plugins that lack one) to derive the committed-tree
 *  contributions from config alone. KNOWN package ids come from the
 *  declared `networks` literals; LOCAL ids stay the all-zero sentinel
 *  (resolved at app build/dev time through `__DEVSTACK_IDS__`). */
const deriveContributions = (members: ReadonlyArray<AnyPlugin>): ReadonlyArray<CodegenableDecl> => {
	const decls: Array<CodegenableDecl> = [];
	for (const member of members) {
		if (member.staticCodegen === undefined) continue;
		decls.push(...member.staticCodegen());
	}
	return decls;
};

/** Which Move-summary runner the stack-free codegen verb uses.
 *
 *   - `host`   — invoke a local `sui` CLI on PATH directly (fast, no Docker).
 *   - `docker` — run `sui move summary` inside the pinned Sui CLI image
 *     (the same runner `boot.ts` wires for `up`/`apply`). Needs Docker but
 *     NO host `sui`, which is what CI has.
 *
 * Selection follows `DEVSTACK_CODEGEN_RUNNER` (`docker`/`host`); when unset,
 * auto-detect: use `host` if a `sui` binary is on PATH, else fall back to
 * `docker`. CI never installs `sui`, so it lands on `docker` automatically;
 * a workflow can still force it with `DEVSTACK_CODEGEN_RUNNER=docker`. */
type CodegenRunner = 'host' | 'docker';

/** True if a `sui` binary is resolvable on PATH (cheap `--version` probe). */
const hostSuiAvailable = (): boolean => {
	try {
		const probe = spawnSync('sui', ['--version'], {
			timeout: 5_000,
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		return probe.status === 0;
	} catch {
		return false;
	}
};

const selectCodegenRunner = (): CodegenRunner => {
	const requested = process.env['DEVSTACK_CODEGEN_RUNNER']?.trim().toLowerCase();
	if (requested === 'docker' || requested === 'host') return requested;
	return hostSuiAvailable() ? 'host' : 'docker';
};

/**
 * Build the codegen service layer: `CodegenPathsService` +
 * `MoveSummaryRunnerService` + `MoveCodegenService`, with the Node
 * FileSystem / Path / child-process spawner provided UNDER them. Mirrors
 * `apply`'s substrate-layer provision shape — one merged layer providing
 * the services, with `Logger` supplied as a separate outer layer over the
 * program (`consolePretty` needs no FileSystem).
 *
 * The Move-summary runner is selected per `selectCodegenRunner`. The
 * `host` runner only needs a child-process spawner; the `docker` runner
 * needs the full Docker `ContainerRuntimeService`, so it provides the
 * substrate layer stack (`buildSubstrateLayers`) UNDER it. The Docker
 * runner produces byte-identical bindings to the host runner — it runs the
 * SAME `sui move summary` argv, just inside the pinned CLI image — so the
 * committed `src/generated` tree is independent of which runner emitted it.
 */
const buildCodegenLayer = (appRoot: string, runner: CodegenRunner, identity: ResolvedIdentity) => {
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
	const moveRunner =
		runner === 'docker'
			? layerSuiMoveSummaryRunnerDocker.pipe(
					// The Docker runner only needs `ContainerRuntimeService`; the
					// substrate layer stack provides it (along with the rest of L0).
					// No stack containers are created — only one-shot `sui move
					// summary` runs against the pinned CLI image.
					Layer.provideMerge(
						buildSubstrateLayers(identityValueFor(identity), identity.runtimeRoot),
					),
				)
			: layerSuiMoveSummaryRunnerHost.pipe(Layer.provideMerge(NodeChildProcessSpawner.layer));
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
	identity: ResolvedIdentity,
): Effect.Effect<CommandResult, CliError> => {
	const loader = makeConfigLoader();
	return Effect.gen(function* () {
		const loadExit = yield* Effect.exit(loader.load(configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const loaded = loadExit.value;
		const stack = (loaded as LoadedConfig & { readonly engine: SupervisedStack }).engine;
		const appRoot = dirname(loaded.resolvedConfigPath);

		const contributions = deriveContributions(stack.members);
		const runner = selectCodegenRunner();

		const exit = yield* Effect.exit(
			runEmitCycle({ contributions, trackTree: true }).pipe(
				Effect.provide(buildCodegenLayer(appRoot, runner, identity)),
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
