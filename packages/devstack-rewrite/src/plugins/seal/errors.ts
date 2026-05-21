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
// `ForkIncompatibleError` is a cross-cutting composite-plugin shape
// owned by `substrate/runtime/composite-errors.ts`; seal contributes
// the `sealLocalKeygen` variant via the factory below. Substrate
// owns the canonical re-export; this module does NOT re-export the
// class — the cross-plugin re-export was the cause of a name
// collision at the root barrel.

import { ForkIncompatibleError } from '../../substrate/runtime/composite-errors.ts';

// ---------------------------------------------------------------------------
// SealError — the plugin's primary tagged error
// ---------------------------------------------------------------------------

/** Phases for `SealError`. Closed sum — matches the v3 catalog
 *  (07-seal.md §"Adjacent Seal references" → `engine/phases.ts:79-91`).
 *
 *  Phase semantics:
 *   - `port-alloc`     — router `seal` entrypoint not registered.
 *   - `image`          — image build / pull failed (lifted-sibling
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
 *   - `rotate`         — master-key rotation pipeline failed (sub-phase
 *                        is in the `cause` chain).
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
	| 'rotate'
	| 'seal';

/** Generic Seal plugin error. The structured shape mirrors the v3
 *  `SealError` from `engine/errors.ts:325-341` minus the dead
 *  `keyServer` field (07-seal.md §Opportunities #6).
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

// ---------------------------------------------------------------------------
// ForkIncompatibleError — shared shape owned by substrate
// ---------------------------------------------------------------------------

/** Synchronous refusal raised at factory time when a local-keygen
 *  variant is composed under a fork network. Refusal MUST be a
 *  synchronous throw at the factory call site (NOT a deferred
 *  acquire-time failure) so the user sees the actionable hint before
 *  any other plugin starts work. */
export const forkIncompatibleError = (
	parts: ConstructorParameters<typeof ForkIncompatibleError>[0],
): ForkIncompatibleError => new ForkIncompatibleError(parts);

// ---------------------------------------------------------------------------
// Error-tag inventory
// ---------------------------------------------------------------------------

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const SEAL_ERROR_TAGS = ['SealError', 'ForkIncompatibleError'] as const;

/** Union of every error a Seal-plugin caller may encounter. */
export type SealAnyError = SealError | ForkIncompatibleError;
