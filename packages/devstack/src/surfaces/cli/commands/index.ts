// CLI commands barrel + shared command context shape.
//
// Each verb file owns its own deps interface and `run*` entry point.
// The dispatcher (`../index.ts`) composes the deps and routes argv to
// the right `run*`. No verb imports another verb; cross-verb concerns
// (confirm tier, snapshot name resolution) live in this barrel or
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

export { runConfig, type ConfigDeps } from './config.ts';
export {
	runDoctor,
	type DoctorDeps,
	type Probe,
	type ProbeOutcome,
	type ProbeReport,
} from './doctor.ts';
export {
	DEFAULT_PRUNE_RESOURCES,
	defaultPruneSelection,
	groupResourceCountForResources,
	hasPruneResources,
	runPrune,
	summarizePruneGroups,
	summarizePruneGroupsForResources,
	type PruneDeps,
	type PruneGroup,
	type PruneInventory,
	type PruneOutcome,
	type PruneResourceScope,
	type PruneRunOptions,
	type PruneSelection,
	type PruneSummary,
	type PruneTargetSelection,
	type PruneTotals,
} from './prune.ts';
export {
	runSnapshot,
	type SnapshotDeps,
	type SnapshotEntry,
	type SnapshotReader,
} from './snapshot.ts';
export { buildStatusPayload, runStatus, type StatusDeps, type StatusReader } from './status.ts';
export { type ConfigLoader, type LoadedConfig } from './config-loader.ts';
export { confirmDestructive, type ConfirmPrompt, type ConfirmPromptInput } from './confirm.ts';
export { runWipe, type WipeDeps } from './wipe.ts';
export { probeSupervisorPresence, type SupervisorPresence } from './supervisor-presence.ts';
