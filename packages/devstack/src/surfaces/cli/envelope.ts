// CLI surface — stable JSON envelope.
//
// Architecture (distilled/20-cli.md § Output formats / Invariants):
//   - Exactly one envelope per command on stdout in `--json` mode.
//   - Schema version pinned; bumped intentionally on breaking changes.
//   - Absent fields are OMITTED from serialized output (no
//     `undefined`).
//   - Envelope must never carry devstack-internal types — no engine
//     class instances, no raw Effect Causes, no plugin error objects.
//     The cascade formatter projects causes into the flat error block;
//     `data` is a JSON-safe blob.
//
// The envelope is the CLI's contract with downstream automation
// (CI, agents, examples). Treat it as a public schema: ANY field-name
// change is a major version bump.

import { ExitCode, exitCodeName } from './sysexits.ts';

/**
 * Current envelope schema version. Bump on any incompatible field
 * rename / shape change. Additive fields (omitted-when-absent) do NOT
 * require a bump.
 *
 * Semantic: integer, monotonically increasing. Consumers MAY refuse to
 * parse an envelope whose `schemaVersion` exceeds their pinned
 * maximum.
 */
export const ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Flat error block carried inside the envelope. NEVER a raw Effect
 *  Cause — the cascade formatter projects causes into `chain[]`. */
export interface EnvelopeError {
	/** Sysexits name, e.g. `'CONFIG'`. */
	readonly code: string;
	/** Sysexits numeric, e.g. 78. Mirrors the OS exit code. */
	readonly exitCode: number;
	/** Single-line summary fit for a TTY one-liner. */
	readonly summary: string;
	/** Optional remediation hint ("run `devstack doctor` to verify
	 *  Docker is reachable"). */
	readonly hint?: string;
	/** Optional copy-pasteable recipe block (multi-line). */
	readonly recipe?: string;
	/** Cascade lines, deepest-first. Each entry is a rendered line
	 *  from the cause walker; consumers never see Effect internals. */
	readonly chain?: ReadonlyArray<string>;
	/** Optional structured context (string-keyed primitives only). */
	readonly context?: Readonly<Record<string, string | number | boolean | null>>;
}

/** The envelope shape itself. Required fields surface always. Optional
 *  fields are omitted when not relevant (the builder enforces this).
 *
 *  Streaming verbs (`logs`) use `StreamingEvent` for each tick; the
 *  closing envelope is one final `Envelope`. The `kind` discriminator
 *  on the streaming shape lets `jq` distinguish per-event records
 *  from the closing summary (surfaces review §1). */
export interface Envelope<Data = unknown> {
	readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
	readonly ok: boolean;
	readonly command: string;
	readonly elapsedMs: number;
	readonly data?: Data;
	readonly hints?: ReadonlyArray<string>;
	readonly error?: EnvelopeError;
	readonly dryRun?: true;
}

/** Per-event streaming record. Carries `kind: 'event'` so a consumer
 *  piping through `jq` can filter event records from the closing
 *  `Envelope` by `.kind`. Streaming verbs emit zero-or-more
 *  `StreamingEvent` records followed by exactly one closing `Envelope`. */
export interface StreamingEvent<Data = unknown> {
	readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
	readonly kind: 'event';
	readonly command: string;
	readonly at: string;
	readonly data: Data;
}

/** Build a streaming-event record. The closing envelope is produced via
 *  `successEnvelope` as usual. */
export const streamingEvent = <Data>(params: {
	readonly command: string;
	readonly at: number;
	readonly data: Data;
}): StreamingEvent<Data> => ({
	schemaVersion: ENVELOPE_SCHEMA_VERSION,
	kind: 'event',
	command: params.command,
	at: new Date(params.at).toISOString(),
	data: params.data,
});

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

export interface SuccessParams<Data = unknown> {
	readonly command: string;
	readonly elapsedMs: number;
	readonly data?: Data;
	readonly hints?: ReadonlyArray<string>;
	readonly dryRun?: boolean;
}

/** Build a success envelope. Optional fields collapse cleanly when
 *  absent — the JSON serializer in `output.ts` strips them. */
export const successEnvelope = <Data>(params: SuccessParams<Data>): Envelope<Data> => {
	const env: Mutable<Envelope<Data>> = {
		schemaVersion: ENVELOPE_SCHEMA_VERSION,
		ok: true,
		command: params.command,
		elapsedMs: params.elapsedMs,
	};
	if (params.data !== undefined) env.data = params.data;
	if (params.hints !== undefined && params.hints.length > 0) env.hints = params.hints;
	if (params.dryRun === true) env.dryRun = true;
	return env as Envelope<Data>;
};

export interface FailureParams {
	readonly command: string;
	readonly elapsedMs: number;
	readonly exitCode: ExitCode;
	readonly summary: string;
	readonly hint?: string;
	readonly recipe?: string;
	readonly chain?: ReadonlyArray<string>;
	readonly context?: EnvelopeError['context'];
	readonly hints?: ReadonlyArray<string>;
	readonly dryRun?: boolean;
}

/** Build a failure envelope. The numeric `exitCode` is BOTH the
 *  envelope's `error.exitCode` AND the OS exit code the CLI propagates
 *  via `process.exitCode`. */
export const failureEnvelope = (params: FailureParams): Envelope<never> => {
	const error: Mutable<EnvelopeError> = {
		code: exitCodeName(params.exitCode),
		exitCode: params.exitCode,
		summary: params.summary,
	};
	if (params.hint !== undefined) error.hint = params.hint;
	if (params.recipe !== undefined) error.recipe = params.recipe;
	if (params.chain !== undefined && params.chain.length > 0) error.chain = params.chain;
	if (params.context !== undefined) error.context = params.context;

	const env: Mutable<Envelope<never>> = {
		schemaVersion: ENVELOPE_SCHEMA_VERSION,
		ok: false,
		command: params.command,
		elapsedMs: params.elapsedMs,
		error: error as EnvelopeError,
	};
	if (params.hints !== undefined && params.hints.length > 0) env.hints = params.hints;
	if (params.dryRun === true) env.dryRun = true;
	return env as Envelope<never>;
};

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** Local `Mutable<T>` — the envelope is built mutably, then frozen by
 *  the caller via `as`. We don't mutate after publish. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
