// Deepbook plugin — typed errors.
//
// Errors raised and consumed inside the DeepBook plugin live here.
// Cross-service errors that deepbook *consumes* but the substrate
// raises (e.g. `ArtifactPublishError`, `SuiExecuteError`,
// `ContainerRuntimeError`) come from the substrate's primitives — we
// don't redeclare those.
//
// `ForkIncompatibleError` is a cross-cutting mode-refusal shape
// owned by `substrate/runtime/mode-errors.ts`; deepbook contributes
// the `deepbookLocal` variant via the factory in `index.ts`.
//
// Effect v4: plain interfaces with `_tag` discriminator (per
// surrounding L2 subsystem style — STYLE_GUIDE §2). `Effect.catchTag`
// matches on `_tag`.

// `ForkIncompatibleError` is the canonical substrate shape — import for
// local use; do NOT re-export from this barrel. Consumers reach the
// canonical type via `substrate/runtime/mode-errors.ts` (or the
// root barrel once wired). Re-exporting per-plugin would collide with
// the walrus / seal barrels under a single root-barrel re-export.
import { ForkIncompatibleError } from '../../substrate/runtime/mode-errors.ts';
import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

/** Phases for `DeepbookPluginError`. Closed sum — keeps the
 *  cause-walker's display table small. */
export type DeepbookPhase =
	| 'image-pull'
	| 'network'
	| 'publish'
	| 'create-pools'
	| 'pyth-publish'
	| 'pyth-feed'
	| 'pyth-pusher'
	| 'indexer'
	| 'server'
	| 'market-maker'
	| 'fund-deep'
	| 'margin-publish'
	| 'margin-seed'
	| 'mint-deep'
	| 'mint-usdc';

/** Generic Deepbook plugin error. Raised by the plugin's acquire
 *  body, sugar factories, and per-phase helpers. */
export interface DeepbookPluginError {
	readonly _tag: 'DeepbookPluginError';
	readonly phase: DeepbookPhase;
	readonly message: string;
	readonly cause?: unknown;
	/** Optional subprocess capture envelope. */
	readonly stderr?: string;
	readonly stdout?: string;
	readonly exitCode?: number;
}

export const deepbookPluginError = (
	phase: DeepbookPhase,
	message: string,
	parts: Omit<DeepbookPluginError, '_tag' | 'phase' | 'message'> = {},
): DeepbookPluginError => ({ _tag: 'DeepbookPluginError', phase, message, ...parts });

/** Configuration error — synchronous factory-time guards (missing
 *  required fields, conflicting pool ids, ambiguous publisher). */
export interface DeepbookConfigError extends ConfigIssue {
	readonly _tag: 'DeepbookConfigError';
}

const makeDeepbookConfigError = defineConfigError('DeepbookConfigError');

export const deepbookConfigError = (
	field: string,
	message: string,
	hint?: string,
	cause?: unknown,
): DeepbookConfigError => makeDeepbookConfigError({ field, message, hint, cause });

/** Union of every error a deepbook-plugin caller may encounter. */
export type DeepbookError = DeepbookPluginError | ForkIncompatibleError | DeepbookConfigError;

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const DEEPBOOK_ERROR_TAGS: ReadonlyArray<DeepbookError['_tag']> = [
	'DeepbookPluginError',
	'ForkIncompatibleError',
	'DeepbookConfigError',
] as const;
