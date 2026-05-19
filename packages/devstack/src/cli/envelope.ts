// Canonical `--json` envelope shared by every CLI subcommand.
//
// Goal: when a caller passes `--json` (or sets `DEVSTACK_JSON=1`) every
// command emits exactly one JSON object on stdout, success or failure,
// with the same top-level shape. Agents can parse the result without
// per-command schema bookkeeping — they branch on `ok`, read
// `error.code` for stable identifiers, and consult `error.exitCode` for
// retry semantics.
//
// Phase A (per `notes/cli-redesign.md` §6) — additive only. Commands
// keep their existing human output untouched; the envelope kicks in
// only under `--json`. Future phases collapse the human + JSON paths
// behind this helper and add `schemaVersion` bumps for breaking shape
// changes.
//
// See also:
//   - `exit-codes.ts` — sysexits-style numeric mapping the envelope's
//     `error.exitCode` field draws from.
//   - `cli-prompt.ts` — interactive confirmation helpers that emit a
//     `CONFIRM_REQUIRED` envelope under `--no-input` instead of
//     prompting.

import { Console, Effect } from 'effect';
import { AlreadyReportedError, failAlreadyReported } from './already-reported.js';
import { type ExitCode } from './exit-codes.js';

/** Stable envelope shape version. Bump on breaking changes. */
export const ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Structured error body inside a non-`ok` envelope. */
export interface EnvelopeError {
	/** Stable identifier (e.g. `SEED_MANIFEST_MISMATCH`, `CONFIRM_REQUIRED`). */
	readonly code: string;
	/** Sysexits-style exit code — see `exit-codes.ts`. */
	readonly exitCode: ExitCode;
	/** Single-line human-readable summary. */
	readonly message: string;
	/** Recommended next-step command (single CLI invocation). */
	readonly hint?: string;
	/** Multi-step recovery recipe. */
	readonly recipe?: string;
	/** Cause-tree JSON; matches existing `causeToJson` shape. */
	readonly cause?: unknown;
	/** Free-form structured context (e.g. on-disk meta vs current). */
	readonly context?: Record<string, unknown>;
}

/** Canonical envelope emitted on stdout under `--json`. */
export interface Envelope<T = unknown> {
	readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
	readonly ok: boolean;
	/** Dot-path command name (e.g. `snapshot.save`, `fork.advance-clock`). */
	readonly command: string;
	readonly data?: T;
	readonly error?: EnvelopeError;
	readonly hints?: ReadonlyArray<string>;
	readonly elapsedMs: number;
	readonly dryRun?: boolean;
}

/** Build a successful envelope. */
export const successEnvelope = <T>(input: {
	readonly command: string;
	readonly data?: T;
	readonly hints?: ReadonlyArray<string>;
	readonly elapsedMs: number;
	readonly dryRun?: boolean;
}): Envelope<T> => ({
	schemaVersion: ENVELOPE_SCHEMA_VERSION,
	ok: true,
	command: input.command,
	...(input.data !== undefined ? { data: input.data } : {}),
	...(input.hints !== undefined && input.hints.length > 0 ? { hints: input.hints } : {}),
	elapsedMs: input.elapsedMs,
	...(input.dryRun === true ? { dryRun: true } : {}),
});

/** Build an error envelope. */
export const errorEnvelope = (input: {
	readonly command: string;
	readonly error: EnvelopeError;
	readonly elapsedMs: number;
	readonly dryRun?: boolean;
	readonly hints?: ReadonlyArray<string>;
}): Envelope<never> => ({
	schemaVersion: ENVELOPE_SCHEMA_VERSION,
	ok: false,
	command: input.command,
	error: input.error,
	...(input.hints !== undefined && input.hints.length > 0 ? { hints: input.hints } : {}),
	elapsedMs: input.elapsedMs,
	...(input.dryRun === true ? { dryRun: true } : {}),
});

/** Emit an envelope as a single JSON line on stdout. */
export const emitEnvelope = (envelope: Envelope<unknown>): Effect.Effect<void> =>
	Console.log(JSON.stringify(envelope));

/** Detect whether the caller wants JSON output. Honors the `--json`
 *  flag AND the `DEVSTACK_JSON=1` env var so wrapper scripts can flip
 *  every command at once. */
export const jsonModeEnabled = (jsonFlag: boolean): boolean => {
	if (jsonFlag) return true;
	const env = process.env.DEVSTACK_JSON;
	return env === '1' || env === 'true';
};

/** Detect whether the caller has opted out of prompts. Honors `--no-input`,
 *  the `DEVSTACK_NO_INPUT=1` env var, and (per clig.dev) a non-TTY stdin
 *  when no `--yes` was passed. CI runs are non-interactive by default. */
export const inputDisabled = (input: { readonly noInput: boolean }): boolean => {
	if (input.noInput) return true;
	const env = process.env.DEVSTACK_NO_INPUT;
	if (env === '1' || env === 'true') return true;
	return false;
};

/** Collapse the canonical "build error envelope → emit it under --json
 *  (or print a human-readable fallback) → raise `AlreadyReportedError`"
 *  trio that every CLI subcommand otherwise spells out by hand. The
 *  envelope shape is preserved exactly; the only output difference under
 *  `--json` is that callers no longer need to repeat the `if (useJson)`
 *  branch and the `failAlreadyReported(envelope.error!.message)` follow-up.
 *
 *  When `json` is false and `humanFallback` is supplied it runs before
 *  the failure (e.g. to emit a "cancelled by operator — no changes made"
 *  line on stdout) so subcommands can keep their existing human output. */
export const failWithEnvelope = (input: {
	readonly command: string;
	readonly error: EnvelopeError;
	readonly elapsedMs: number;
	readonly dryRun?: boolean;
	readonly hints?: ReadonlyArray<string>;
	readonly json: boolean;
	readonly humanFallback?: Effect.Effect<void>;
}): Effect.Effect<never, AlreadyReportedError> =>
	Effect.gen(function* () {
		const envelope = errorEnvelope({
			command: input.command,
			error: input.error,
			elapsedMs: input.elapsedMs,
			...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
			...(input.hints !== undefined ? { hints: input.hints } : {}),
		});
		if (input.json) {
			yield* emitEnvelope(envelope);
		} else if (input.humanFallback !== undefined) {
			yield* input.humanFallback;
		}
		return yield* failAlreadyReported(envelope.error!.message);
	});
