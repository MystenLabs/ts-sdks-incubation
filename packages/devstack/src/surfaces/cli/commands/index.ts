// CLI commands barrel + shared command context shape.
//
// Each verb file owns its own deps interface and `run*` entry point.
// The dispatcher (`../index.ts`) composes the deps and routes argv to
// the right `run*`. No verb imports another verb; cross-verb concerns
// (confirm tier, snapshot label resolution) live in this barrel or
// in dedicated sibling modules.

import type { Effect } from 'effect';

import type { CliError } from '../errors.ts';
import type { GlobalFlags } from '../flags.ts';
import type { CliIO } from '../output.ts';

/** Everything a verb needs that is not verb-specific. */
export interface CommandContext {
	readonly flags: GlobalFlags;
	readonly io: CliIO;
}

/** Verb outcome. The numeric `exitCode` field is informational — the
 *  dispatcher already calls `io.setExitCode` via `emitSuccess` /
 *  `emitFailure`. It is included here so the dispatcher's outer
 *  fold can pattern-match on the success / failure shape. */
export interface CommandResult {
	readonly exitCode: number;
}

/** Uniform verb signature. Every `run*` function in this folder
 *  matches `(deps, ctx) => Effect<CommandResult, CliError>`. The
 *  dispatcher binds `deps` via a thin Layer. */
export type VerbRunner<Deps> = (
	deps: Deps,
	ctx: CommandContext,
) => Effect.Effect<CommandResult, CliError>;

// --- Re-exports ---------------------------------------------------------

export { runApply, type ApplyDeps } from './apply.ts';
export { runCodegen, type CodegenDeps } from './codegen.ts';
export { runConfig, type ConfigDeps } from './config.ts';
export {
	runDoctor,
	type DoctorDeps,
	type Probe,
	type ProbeOutcome,
	type ProbeReport,
} from './doctor.ts';
export { runDown, type DownDeps } from './down.ts';
export { runExec, runNodeChildProcess, type ExecDeps } from './exec.ts';
export { runFork, type ForkDeps } from './fork.ts';
export { runLogs, type LogsDeps } from './logs.ts';
export { runPrune, type PruneDeps } from './prune.ts';
export {
	runSnapshot,
	type SnapshotDeps,
	type SnapshotEntry,
	type SnapshotReader,
} from './snapshot.ts';
export { runStack, type StackDeps, type StackEntry } from './stack.ts';
export { buildStatusPayload, runStatus, type StatusDeps, type StatusReader } from './status.ts';
export {
	runUp,
	type UpDeps,
	type ConfigLoader,
	type LoadedConfig,
	type ShutdownLatch,
} from './up.ts';
export { runWipe, type WipeDeps } from './wipe.ts';
export { type CommandPublisher, type EventSubscriber } from './command-channel.ts';
export { probeSupervisorPresence, type SupervisorPresence } from './supervisor-presence.ts';
export {
	makeChannelPublisher,
	makeChannelSubscriber,
	type ChannelDepsContext,
} from './channel-deps.ts';
export {
	defaultProbes,
	routerProfileProbe,
	type DoctorCommandRunner,
	type PortAvailabilityProbe,
	type RouterProfileProbeOptions,
} from './doctor-probes.ts';
