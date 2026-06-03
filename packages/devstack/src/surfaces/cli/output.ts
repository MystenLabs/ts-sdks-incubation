// CLI surface — output rendering (human / JSON envelope / structured
// pretty error).
//
// Architecture (distilled/20-cli.md § Output formats):
//   - JSON envelope on stdout EXACTLY ONCE per command in `--json`
//     mode; stderr never receives the envelope.
//   - Human text on stdout otherwise.
//   - Pretty error tree on stderr only on failure — and only if the
//     subcommand hasn't already rendered (the `CliAlreadyReportedError`
//     sentinel suppresses).
//
// This module owns all stdout/stderr writes for the CLI. Subcommands
// build envelope params; this module serializes and emits.

import { Effect } from 'effect';
import type { Cause } from 'effect';

import {
	formatCause,
	formatValue,
} from '../../substrate/runtime/observability/cascade-formatter.ts';
import {
	type Envelope,
	failureEnvelope,
	type FailureParams,
	type StreamingEvent,
	successEnvelope,
	type SuccessParams,
} from './envelope.ts';
import { type CliError, exitCodeFor, hintFor, summaryFor } from './errors.ts';
import type { OutputMode } from './flags.ts';
import { type ExitCode } from './sysexits.ts';

// -----------------------------------------------------------------------------
// I/O service abstraction
// -----------------------------------------------------------------------------

/** Surface-level IO. Tests substitute a buffered impl. */
export interface CliIO {
	readonly writeStdout: (line: string) => Effect.Effect<void>;
	readonly writeStderr: (line: string) => Effect.Effect<void>;
	readonly setExitCode: (code: number) => Effect.Effect<void>;
}

/** Default IO bound to the Node process. */
export const nodeProcessIO: CliIO = {
	writeStdout: (line) =>
		Effect.sync(() => {
			process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
		}),
	writeStderr: (line) =>
		Effect.sync(() => {
			process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
		}),
	setExitCode: (code) =>
		Effect.sync(() => {
			process.exitCode = code;
		}),
};

// -----------------------------------------------------------------------------
// Stable JSON serialization
// -----------------------------------------------------------------------------

/**
 * `JSON.stringify` strips `undefined` from objects but NOT from
 * arrays (replaces with `null`). The envelope builders already omit
 * absent keys, but we add a guard so a future builder bug doesn't
 * leak `undefined` into automation output.
 *
 * Architecture: "Absent fields are OMITTED from serialized output (no
 * `undefined`)." This function enforces that promise.
 */
export const serializeEnvelope = (env: Envelope<unknown> | StreamingEvent<unknown>): string => {
	const cleaned = stripUndefined(env);
	return JSON.stringify(cleaned);
};

const stripUndefined = (value: unknown): unknown => {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (v === undefined) continue;
		out[k] = stripUndefined(v);
	}
	return out;
};

// -----------------------------------------------------------------------------
// Success path
// -----------------------------------------------------------------------------

/**
 * Emit a success envelope OR a human-mode line block. Sets exit code
 * 0 unless a streaming success path supplies its own process code.
 *
 * In JSON mode: one envelope on stdout, nothing on stderr.
 * In human mode: each `humanLines` entry on stdout; hints rendered
 * after; no envelope.
 */
export const emitSuccess = <Data>(
	io: CliIO,
	mode: OutputMode,
	params: SuccessParams<Data> & {
		readonly humanLines?: ReadonlyArray<string>;
		/** Override the OS exit code for commands whose transport
		 *  succeeded but whose payload carries a process-style status. */
		readonly exitCode?: number;
	},
): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (mode === 'json') {
			const env = successEnvelope({
				command: params.command,
				elapsedMs: params.elapsedMs,
				data: params.data,
				hints: params.hints,
				dryRun: params.dryRun,
			});
			yield* io.writeStdout(serializeEnvelope(env));
		} else {
			for (const line of params.humanLines ?? []) {
				yield* io.writeStdout(line);
			}
			for (const hint of params.hints ?? []) {
				yield* io.writeStdout(`hint: ${hint}`);
			}
		}
		yield* io.setExitCode(params.exitCode ?? 0);
	});

// -----------------------------------------------------------------------------
// Failure path
// -----------------------------------------------------------------------------

/**
 * Emit a failure for a `CliError`. Threads the sysexit code through
 * to `process.exitCode`. Honors the already-reported sentinel.
 *
 * Architecture invariant: "Top-level error rendering must not
 * double-print when a subcommand already rendered." — we still set the
 * exit code but skip the envelope/stderr write.
 */
export const emitFailure = (
	io: CliIO,
	mode: OutputMode,
	params: {
		readonly command: string;
		readonly elapsedMs: number;
		readonly error: CliError;
		readonly cause?: Cause.Cause<unknown>;
		readonly dryRun?: boolean;
	},
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const exitCode = exitCodeFor(params.error);
		if (params.error._tag === 'CliAlreadyReportedError') {
			yield* io.setExitCode(exitCode);
			return;
		}
		yield* renderFailure(io, mode, {
			command: params.command,
			elapsedMs: params.elapsedMs,
			exitCode,
			summary: summaryFor(params.error),
			hint: hintFor(params.error),
			cause: params.cause,
			errorCause:
				'cause' in params.error ? (params.error as { readonly cause?: unknown }).cause : undefined,
			dryRun: params.dryRun,
		});
		yield* io.setExitCode(exitCode);
	});

interface RenderFailureParams {
	readonly command: string;
	readonly elapsedMs: number;
	readonly exitCode: ExitCode;
	readonly summary: string;
	readonly hint?: string;
	readonly cause?: Cause.Cause<unknown>;
	readonly errorCause?: unknown;
	readonly dryRun?: boolean;
}

const renderFailure = (io: CliIO, mode: OutputMode, p: RenderFailureParams): Effect.Effect<void> =>
	Effect.gen(function* () {
		const rawChain =
			p.cause !== undefined
				? formatCause(p.cause)
				: p.errorCause !== undefined
					? formatValue(p.errorCause)
					: undefined;
		const chain = rawChain?.split('\n').filter((l) => l.length > 0);

		if (mode === 'json') {
			const fp: FailureParams = {
				command: p.command,
				elapsedMs: p.elapsedMs,
				exitCode: p.exitCode,
				summary: p.summary,
				hint: p.hint,
				chain,
				dryRun: p.dryRun,
			};
			yield* io.writeStdout(serializeEnvelope(failureEnvelope(fp)));
			return;
		}

		// Human mode: one-line summary on stderr, then optional hint and
		// the cascade chain (if present), all on stderr.
		yield* io.writeStderr(`error: ${p.summary}`);
		if (p.hint !== undefined) {
			yield* io.writeStderr(`hint: ${p.hint}`);
		}
		if (chain !== undefined && chain.length > 0) {
			for (const line of chain) {
				yield* io.writeStderr(`  ${line}`);
			}
		}
	});
