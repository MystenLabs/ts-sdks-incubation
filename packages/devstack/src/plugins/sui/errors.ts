// Sui plugin — typed errors.
//
// Distilled-doc finding: today's codebase centralises EVERY tagged
// error in one engine file, but consumer boundaries cross service
// lines. The architecture lets us redistribute: errors raised AND
// consumed inside the Sui plugin live here. Cross-service errors
// (`ForkIncompatibleError`, `SeedManifestMismatchError`) live with
// the plugin that consumes them — Walrus/Seal/Deepbook own
// `ForkIncompatibleError`; the seed-manifest error stays here
// because Sui's fork acquire is the only raise site AND the only
// consumer.
//
// Effect v4: errors are plain interfaces with a `_tag` discriminator
// — we don't subclass an Effect base class; `Effect.catchTag` /
// `catchTags` match on `_tag` literal. See architecture § Effect.

import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

/** Phases for `SuiError`. Closed sum — keeps the cause-walker's
 *  display table small. Add a phase only after editing the
 *  catalog in the plugin doc. */
export type SuiPhase =
	| 'image-build'
	| 'port-allocate'
	| 'container-start'
	| 'rpc-probe'
	| 'faucet-probe'
	| 'graphql-probe'
	| 'fork-status-probe'
	| 'chain-id-fetch'
	| 'wait-funds-ready'
	| 'fork-impersonate'
	| 'fork-advance-clock'
	| 'fork-advance-checkpoint'
	| 'fork-lock'
	| 'fork-data-dir'
	| 'move-build'
	| 'move-publish';

/** Generic Sui plugin error. Raised by the plugin's acquire body
 *  and its admin surface (`advanceClock`, `impersonate`, …). */
export interface SuiPluginError {
	readonly _tag: 'SuiPluginError';
	readonly phase: SuiPhase;
	readonly message: string;
	readonly cause?: unknown;
}

export const suiPluginError = (
	phase: SuiPhase,
	message: string,
	cause?: unknown,
): SuiPluginError => ({ _tag: 'SuiPluginError', phase, message, cause });

export interface SuiConfigError extends ConfigIssue {
	readonly _tag: 'SuiConfigError';
}

export const suiConfigError = defineConfigError('SuiConfigError');

/** Move-build / sui-cli error. Carries the sub-process capture
 *  envelope (exit + stderr + stdout). The plugin doc lists 11
 *  shell-shaped phases today; we tighten to a much smaller set
 *  and use `op` as a free-form column.
 *
 *  Stub: the closed-vs-open phase decision is deferred to the
 *  cli-driver implementation pass. */
export interface SuiCliError {
	readonly _tag: 'SuiCliError';
	readonly op: 'build' | 'publish' | 'summary' | 'scrub' | 'spawn';
	readonly exitCode?: number;
	readonly stderr?: string;
	readonly stdout?: string;
	readonly cause?: unknown;
}

export const suiCliError = (
	op: SuiCliError['op'],
	parts: Omit<SuiCliError, '_tag' | 'op'>,
): SuiCliError => ({ _tag: 'SuiCliError', op, ...parts });

/** Synchronous refusal raised by the fork SDK guard. The guard
 *  intercepts at property-access time so the wire call never
 *  happens — failing fast lets callers branch on this without
 *  awaiting a transport-level reject. */
export interface ForkUnsupportedError {
	readonly _tag: 'ForkUnsupportedError';
	readonly surface: string;
	readonly hint: string;
}

export const forkUnsupportedError = (surface: string, hint: string): ForkUnsupportedError => ({
	_tag: 'ForkUnsupportedError',
	surface,
	hint,
});

/** Raised when fork meta-config drifts between supervisor boots.
 *  Carries previous + current snapshots so the doctor / TUI can
 *  diff them. Consumed inside Sui's fork acquire — does NOT cross
 *  plugin boundaries (the recipe is "wipe and re-apply"). */
export interface SeedManifestMismatchError {
	readonly _tag: 'SeedManifestMismatchError';
	readonly previous: {
		readonly upstream: string;
		readonly checkpoint?: string;
		readonly configHash: string;
	};
	readonly current: {
		readonly upstream: string;
		readonly checkpoint?: string;
		readonly configHash: string;
	};
	readonly hint: string;
}

/** Raised when the funds-ready gate times out against a real
 *  faucet. Plugin-internal — Sui contributes this strategy and
 *  consumes its own error. */
export interface SuiFundsReadyError {
	readonly _tag: 'SuiFundsReadyError';
	readonly attempts: number;
	readonly lastBody?: string;
	readonly hint: string;
}

/** Union of every error a Sui-plugin caller may encounter. */
export type SuiError =
	| SuiPluginError
	| SuiCliError
	| SuiConfigError
	| ForkUnsupportedError
	| SeedManifestMismatchError
	| SuiFundsReadyError;

/** Error tags this plugin contributes — surfaced to the cause
 *  walker via `PluginErrorContribution`. */
export const SUI_ERROR_TAGS: ReadonlyArray<SuiError['_tag']> = [
	'SuiPluginError',
	'SuiCliError',
	'SuiConfigError',
	'ForkUnsupportedError',
	'SeedManifestMismatchError',
	'SuiFundsReadyError',
] as const;
