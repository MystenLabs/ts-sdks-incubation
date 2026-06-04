// Seal plugin — typed errors.
//
// Every error surfacing site that may carry stdout/stderr from the
// seal-cli MUST run the bytes through a master-key redactor. The
// redactor lives in `keygen.ts` so the keygen pipeline is the single
// owner of the redaction substrate; this file only declares the
// closed phase set + the structured error shapes.
//
// Effect v4: errors are plain interfaces with a `_tag` discriminator
// (per surrounding subsystem style). `Effect.catchTag` / `catchTags`
// match on the literal `_tag`.
//
// `ForkIncompatibleError` is a cross-cutting mode-refusal shape
// owned by `substrate/runtime/mode-errors.ts`; seal contributes
// the `sealLocalKeygen` variant via the factory below. Substrate
// owns the canonical re-export; this module does NOT re-export the
// class — the cross-plugin re-export was the cause of a name
// collision at the root barrel.

import { ForkIncompatibleError } from '../../substrate/runtime/mode-errors.ts';
import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

// ---------------------------------------------------------------------------
// SealError — the plugin's primary tagged error
// ---------------------------------------------------------------------------

/** Phases for `SealError`. Closed sum (07-seal.md §"Adjacent Seal
 *  references").
 *
 *  Phase semantics:
 *   - `port-alloc`     — router `seal` entrypoint not registered.
 *   - `image`          — image build / pull failed (bootstrap-asset
 *                        cargo step).
 *   - `keygen`         — `seal-cli genkey` container failed OR stdout
 *                        parse failed.
 *   - `publish`        — Move publish of the seal contracts failed.
 *   - `register`       — `KeyServer::create_and_transfer_v2_independent_server`
 *                        Move call failed OR object id parse failed.
 *   - `config-render`  — key-server-config.yaml / master-key.env write
 *                        failed (FS perms, disk full).
 *   - `container`      — long-running key-server container start failed.
 *   - `ready`          — /health probe timed out.
 *   - `seal`           — generic catch-all for non-phaseable failures. */
export type SealPhase =
	| 'port-alloc'
	| 'image'
	| 'keygen'
	| 'publish'
	| 'register'
	| 'config-render'
	| 'container'
	| 'ready'
	| 'seal';

/** Generic Seal plugin error. A structured tagged error
 *  (07-seal.md §Opportunities #6).
 *
 *  Distilled-doc invariant #16: `stdout` / `stderr` MUST be redacted
 *  via `redactMasterKey` at every raise site that touches `seal-cli`
 *  output. The raise sites in this plugin pipe their captures
 *  through the redactor before constructing the error. */
export interface SealError {
	readonly _tag: 'SealError';
	readonly phase: SealPhase;
	/** Seal instance name (default `'seal'`). Folds into TUI display
	 *  + cause-walker context. */
	readonly name: string;
	readonly message: string;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly exitCode?: number;
	readonly cause?: unknown;
}

export const sealError = (
	phase: SealPhase,
	parts: Omit<SealError, '_tag' | 'phase'>,
): SealError => ({ _tag: 'SealError', phase, ...parts });

/** Structural predicate — true iff `value` has the `SealError` tag.
 *  Used at re-wrap sites (e.g. `key-server.ts` probe mapError) to
 *  unwrap a nested `SealError` rather than re-wrap and create a
 *  two-layer cause walk. */
export const isSealError = (value: unknown): value is SealError =>
	typeof value === 'object' &&
	value !== null &&
	(value as { readonly _tag?: unknown })._tag === 'SealError';

// ---------------------------------------------------------------------------
// SealConfigError — synchronous factory-time configuration faults
// ---------------------------------------------------------------------------

export interface SealConfigError extends ConfigIssue {
	readonly _tag: 'SealConfigError';
}

export const sealConfigError = defineConfigError('SealConfigError');

// ---------------------------------------------------------------------------
// Error-tag inventory
// ---------------------------------------------------------------------------

/** The catchable error tags this plugin exposes. Pinned against the
 *  user-facing error catalog by the error-catalog-parity test. */
export const SEAL_ERROR_TAGS = ['SealError', 'ForkIncompatibleError', 'SealConfigError'] as const;

/** Union of every error a Seal-plugin caller may encounter. */
export type SealAnyError = SealError | ForkIncompatibleError | SealConfigError;
