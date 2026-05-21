// CLI surface — top-level entry point.
//
// Architecture (distilled/20-cli.md § Surface-equality principle): the
// CLI is a peer of TUI / programmable API / codegen / build-integrations.
// This file owns argv → command dispatch ONLY. Everything else
// (engine boot, supervisor wiring, renderer mount) is the
// dispatcher's job — the CLI hands typed commands to the command
// channel and projects typed events back out.
//
// Per-invocation shape (architecture § Lifecycle / invocation
// patterns):
//
//     parse → maybe-override-env → maybe-load-config → dispatch
//             → render → teardown → exit
//
// This module implements the first and last steps; the middle steps
// are delegated to per-verb `run*` functions.
//
// ARCHITECTURE INVARIANTS ENFORCED HERE:
//   - `up` MUST run as the outer Node fiber (no nested runtime),
//     otherwise SIGINT cannot reach finalizers. Callers run the
//     returned Effect with `Effect.runFork` at the bin entry.
//   - Network override applies BEFORE config import. The dispatcher
//     writes `process.env.DEVSTACK_NETWORK` before `loader.load` runs.
//   - Top-level error rendering MUST skip already-reported failures
//     (`CliAlreadyReportedError` sentinel).
//   - Exactly one envelope per JSON-mode invocation on stdout.

import { Effect } from 'effect';

import { commandSchema, formatCommandHelp, isVerb, VERBS, type Verb } from './command-tree.ts';
import { type CliError, CliInternalError, CliUsageError } from './errors.ts';
import { ENV_VARS, type GlobalFlags, parseGlobalFlags } from './flags.ts';
import { type CliIO, emitFailure, nodeProcessIO } from './output.ts';
import {
	type ApplyDeps,
	type CodegenDeps,
	type CommandContext,
	type CommandResult,
	type ConfigDeps,
	type DoctorDeps,
	type DownDeps,
	type ForkDeps,
	type LogsDeps,
	type PruneDeps,
	type StackDeps,
	type WipeDeps,
	runApply,
	runCodegen,
	runConfig,
	runDoctor,
	runDown,
	runFork,
	runLogs,
	runPrune,
	runSnapshot,
	runStack,
	runStatus,
	runUp,
	runWipe,
	type SnapshotDeps,
	type StatusDeps,
	type UpDeps,
} from './commands/index.ts';

// -----------------------------------------------------------------------------
// Verb deps bundle
// -----------------------------------------------------------------------------

/**
 * The dispatcher's deps bundle. Each verb's deps are independently
 * pluggable, so tests can inject only the seams the verb under test
 * needs (the others go undefined and that verb fails fast).
 *
 * In production the bin entry composes a single deps bundle from the
 * substrate layer + the L1/L3 orchestrator layers and passes it here.
 */
export interface CliDeps {
	readonly up: UpDeps;
	readonly down: DownDeps;
	readonly status: StatusDeps;
	readonly snapshot: SnapshotDeps;
	readonly prune: PruneDeps;
	readonly logs: LogsDeps;
	readonly doctor: DoctorDeps;
	readonly codegen: CodegenDeps;
	readonly config: ConfigDeps;
	readonly apply: ApplyDeps;
	readonly wipe: WipeDeps;
	readonly stack: StackDeps;
	readonly fork: ForkDeps;
}

export interface DispatchEnv {
	readonly argv: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdinIsTty: boolean;
	readonly io?: CliIO;
}

/**
 * Top-level dispatcher. Returns an Effect that resolves once the verb
 * has finished. Sets `process.exitCode` via the IO seam; does NOT call
 * `process.exit` — that is the bin entry's responsibility, after the
 * Effect's surrounding scope has closed.
 */
export const dispatch = (deps: CliDeps, dispatchEnv: DispatchEnv): Effect.Effect<void> =>
	Effect.gen(function* () {
		const io = dispatchEnv.io ?? nodeProcessIO;
		let flags: GlobalFlags;
		try {
			flags = parseGlobalFlags(dispatchEnv.argv, {
				env: dispatchEnv.env,
				stdinIsTty: dispatchEnv.stdinIsTty,
			});
		} catch (cause) {
			if (cause instanceof CliUsageError) {
				yield* emitFailure(io, 'human', {
					command: '(parse)',
					elapsedMs: 0,
					error: cause,
				});
				return;
			}
			throw cause;
		}

		// `--schema --json` short-circuits before any IO or config load.
		if (flags.schemaEmit) {
			yield* emitSchema(io, flags);
			yield* io.setExitCode(0);
			return;
		}

		// `--version` and `--help` are also short-circuits.
		if (flags.version) {
			yield* io.writeStdout('devstack 0.0.0');
			yield* io.setExitCode(0);
			return;
		}
		if (flags.help) {
			yield* io.writeStdout(formatCommandHelp(flags.rest));
			yield* io.setExitCode(0);
			return;
		}

		// Apply `--network` to `process.env` BEFORE config import. The
		// loader reads env at top level, so this MUST happen now.
		if (flags.network !== undefined) {
			yield* Effect.sync(() => {
				process.env[ENV_VARS.NETWORK] = flags.network;
			});
		}

		const [verb, ...rest] = flags.rest;
		if (verb === undefined) {
			yield* emitFailure(io, flags.outputMode, {
				command: '(no verb)',
				elapsedMs: 0,
				error: new CliUsageError({
					message: 'no command specified',
					hint: 'try one of: up, down, status, snapshot, prune, doctor, logs, codegen, config, apply, wipe, stack, fork',
				}),
			});
			return;
		}
		if (!isVerb(verb)) {
			yield* emitFailure(io, flags.outputMode, {
				command: '(unknown verb)',
				elapsedMs: 0,
				error: new CliUsageError({
					message: `unknown command: ${verb}`,
					hint: `available: ${VERBS.join(', ')}`,
				}),
			});
			return;
		}

		// The verb's own argv lives in `flags.rest` minus the verb head.
		const verbCtx: CommandContext = {
			flags: { ...flags, rest },
			io,
		};

		const verbEffect = runVerb(verb, deps, verbCtx);
		yield* verbEffect.pipe(
			Effect.catch((error: CliError) =>
				emitFailure(io, flags.outputMode, {
					command: verb,
					elapsedMs: 0,
					error,
				}),
			),
			Effect.catchCause((cause) =>
				// Defects escape the typed-error channel; render them with
				// the cascade formatter so the user gets the same shape.
				emitFailure(io, flags.outputMode, {
					command: verb,
					elapsedMs: 0,
					error: new CliInternalError({ message: 'unexpected internal failure' }),
					cause,
				}),
			),
		);
	});

// -----------------------------------------------------------------------------
// Verb router
// -----------------------------------------------------------------------------

const runVerb = (
	verb: Verb,
	deps: CliDeps,
	ctx: CommandContext,
): Effect.Effect<CommandResult, CliError> => {
	switch (verb) {
		case 'up':
			return runUp(deps.up, ctx);
		case 'down':
			return runDown(deps.down, ctx);
		case 'status':
			return runStatus(deps.status, ctx);
		case 'snapshot':
			return runSnapshot(deps.snapshot, ctx);
		case 'prune':
			return runPrune(deps.prune, ctx);
		case 'logs':
			return runLogs(deps.logs, ctx);
		case 'doctor':
			return runDoctor(deps.doctor, ctx);
		case 'codegen':
			return runCodegen(deps.codegen, ctx);
		case 'config':
			return runConfig(deps.config, ctx);
		case 'apply':
			return runApply(deps.apply, ctx);
		case 'wipe':
			return runWipe(deps.wipe, ctx);
		case 'stack':
			return runStack(deps.stack, ctx);
		case 'fork':
			return runFork(deps.fork, ctx);
	}
};

// -----------------------------------------------------------------------------
// `--schema --json` action
// -----------------------------------------------------------------------------

const emitSchema = (io: CliIO, flags: GlobalFlags): Effect.Effect<void> =>
	Effect.gen(function* () {
		const schema = {
			...commandSchema(),
			outputMode: flags.outputMode,
		};
		yield* io.writeStdout(JSON.stringify(schema));
	});

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

export type { CliIO } from './output.ts';
export type { GlobalFlags } from './flags.ts';
export {
	COMMAND_TREE,
	commandSchema,
	formatCommandHelp,
	VERBS,
	type Verb,
} from './command-tree.ts';
export type { Envelope, EnvelopeError } from './envelope.ts';
export {
	ENVELOPE_SCHEMA_VERSION,
	failureEnvelope,
	streamingEvent,
	successEnvelope,
	type StreamingEvent,
} from './envelope.ts';
export { ExitCode, exitCodeName } from './sysexits.ts';
export {
	type CliError,
	CliAlreadyReportedError,
	CliConfigInvalidError,
	CliConfigNotFoundError,
	CliConfirmRequiredError,
	CliInternalError,
	CliNoSupervisorError,
	CliSnapshotNotFoundError,
	CliSupervisorLiveError,
	CliUnavailableError,
	CliUsageError,
} from './errors.ts';
