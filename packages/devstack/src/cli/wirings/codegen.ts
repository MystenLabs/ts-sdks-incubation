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

import { dirname, resolve as resolvePath } from 'node:path';

import { Cause, Effect, Exit, Layer, Logger } from 'effect';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import type { CodegenIdResolver, CodegenableDecl } from '../../contracts/codegenable.ts';
import type { AnyPlugin } from '../../substrate/plugin.ts';
import type { SupervisedStack } from '../../substrate/runtime/index.ts';
import { layerMystenMoveCodegen } from '../../orchestrators/codegen/bindings.ts';
import { layerSuiMoveSummaryRunnerHost } from '../../plugins/sui/move-summary-runner.ts';
import {
	layerCodegenPaths,
	layerCodegenRoot,
} from '../../orchestrators/codegen/paths.ts';
import { runEmitCycle } from '../../orchestrators/codegen/service.ts';
import { isUnresolvedId, UNRESOLVED_ID } from '../../orchestrators/codegen/id-config.ts';
import { type CliError, CliInternalError } from '../../surfaces/cli/errors.ts';
import { type CommandResult } from '../../surfaces/cli/commands/index.ts';
import { ExitCode } from '../../surfaces/cli/sysexits.ts';
import type { LoadedConfig } from '../../surfaces/cli/commands/config-loader.ts';

import { cliErrorFromConfigExit } from '../bail.ts';
import { makeConfigLoader } from './config-loader.ts';

/** Build the id-resolver the plugin `staticCodegen` hooks read. A KNOWN
 *  package carries a declared per-network literal in config — honor it;
 *  otherwise the all-zero sentinel (resolved at app build time through
 *  `__DEVSTACK_IDS__`). The committed stub never embeds a real LOCAL id. */
const makeIdResolver = (): CodegenIdResolver => ({
	packageId: ({ networks }) => {
		if (networks !== undefined) {
			for (const entry of Object.values(networks)) {
				if (!isUnresolvedId(entry.packageId)) return entry.packageId;
			}
		}
		return UNRESOLVED_ID;
	},
});

/** Walk the stack members, calling each plugin spec's `staticCodegen`
 *  hook (skipping plugins that lack one) to derive the committed-tree
 *  contributions from config alone. */
const deriveContributions = (
	members: ReadonlyArray<AnyPlugin>,
	resolver: CodegenIdResolver,
): ReadonlyArray<CodegenableDecl> => {
	const decls: Array<CodegenableDecl> = [];
	for (const member of members) {
		if (member.staticCodegen === undefined) continue;
		decls.push(...member.staticCodegen(resolver));
	}
	return decls;
};

/**
 * Build the codegen service layer: `CodegenPathsService` +
 * `MoveSummaryRunnerService` + `MoveCodegenService`, with the Node
 * FileSystem / Path / child-process spawner provided UNDER them. Mirrors
 * `apply`'s substrate-layer provision shape — one merged layer providing
 * the services, with `Logger` supplied as a separate outer layer over the
 * program (`consolePretty` needs no FileSystem).
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
		const loadExit = yield* Effect.exit(loader.load(configPath));
		if (Exit.isFailure(loadExit)) {
			return yield* Effect.fail(cliErrorFromConfigExit(loadExit));
		}
		const loaded = loadExit.value;
		const stack = (loaded as LoadedConfig & { readonly engine: SupervisedStack }).engine;
		const appRoot = dirname(loaded.resolvedConfigPath);

		const resolver = makeIdResolver();
		const contributions = deriveContributions(stack.members, resolver);

		const exit = yield* Effect.exit(
			runEmitCycle({ contributions, trackTree: true }).pipe(
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
