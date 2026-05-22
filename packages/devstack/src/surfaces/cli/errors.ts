// CLI surface — typed errors carried up to the top-level renderer.
//
// Architecture (distilled/20-cli.md § Edge cases) enumerates the
// surface's failure modes. Each one MUST resolve to a stable sysexit
// code; the error tag here carries that mapping so the dispatcher
// doesn't sprinkle exit codes through every command.
//
// Why tagged errors and not plain `Effect.fail(string)`?
//   - `catchTag` in commands can pick out the precise tag without
//     stringly matching.
//   - The cascade formatter (substrate/runtime/observability/
//     cascade-formatter.ts) renders these natively via their `_tag`.
//   - The `schema --json` command enumerates the tag table.

import { Data } from 'effect';

import { type ExitCode, ExitCode as XC } from './sysexits.ts';

// -----------------------------------------------------------------------------
// Tagged errors
// -----------------------------------------------------------------------------

/** Argv parsing produced an error — unknown subcommand, malformed
 *  flag value, missing required positional. */
export class CliUsageError extends Data.TaggedError('CliUsageError')<{
	readonly message: string;
	readonly hint?: string;
}> {}

/** The user's `devstack.config.ts` could not be located (path probe
 *  exhausted) or could not be imported. */
export class CliConfigNotFoundError extends Data.TaggedError('CliConfigNotFoundError')<{
	readonly message: string;
	readonly searchedPaths?: ReadonlyArray<string>;
}> {}

/** The config imported successfully but its default export is not a
 *  `Stack` value (failed brand check, missing required field). */
export class CliConfigInvalidError extends Data.TaggedError('CliConfigInvalidError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** A required service (Docker daemon, network) is unavailable. */
export class CliUnavailableError extends Data.TaggedError('CliUnavailableError')<{
	readonly message: string;
	readonly service: string;
	readonly hint?: string;
}> {}

/** Snapshot id/label not found. Carries the reference the caller
 *  used so the failure renderer can echo it back. */
export class CliSnapshotNotFoundError extends Data.TaggedError('CliSnapshotNotFoundError')<{
	readonly snapshotRef: string;
}> {}

/** Destructive verb refused because `--yes` was absent and prompting
 *  was forbidden (non-TTY stdin or `--no-input`). */
export class CliConfirmRequiredError extends Data.TaggedError('CliConfirmRequiredError')<{
	readonly verb: string;
	readonly hint?: string;
}> {}

/** Engine reports a live supervisor for the target stack; the verb
 *  refused to mutate shared state. */
export class CliSupervisorLiveError extends Data.TaggedError('CliSupervisorLiveError')<{
	readonly app: string;
	readonly stack: string;
	readonly hint?: string;
}> {}

/** The verb requires a live supervisor (a stack must be `up`) but
 *  none is running for `(app, stack)`. Distinguished from
 *  `CliSupervisorLiveError` (the inverse case where the verb refused
 *  because one IS live). */
export class CliNoSupervisorError extends Data.TaggedError('CliNoSupervisorError')<{
	readonly app: string;
	readonly stack: string;
	readonly hint?: string;
}> {}

/** Internal/unexpected failure. Wraps an arbitrary cause; the cascade
 *  formatter renders the inner. */
export class CliInternalError extends Data.TaggedError('CliInternalError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Sentinel: subcommand already pretty-rendered its failure. The
 *  top-level renderer recognizes this tag and skips re-rendering, but
 *  still propagates `exitCode` to the OS exit code.
 *
 *  Architecture § Learnings: "Already-reported sentinel pattern" — the
 *  marker traverses the cause structure used by the Effect runtime, so
 *  the top-level `Effect.catchAll` sees it. */
export class CliAlreadyReportedError extends Data.TaggedError('CliAlreadyReportedError')<{
	readonly exitCode: ExitCode;
}> {}

// -----------------------------------------------------------------------------
// Union + sysexit projection
// -----------------------------------------------------------------------------

export type CliError =
	| CliUsageError
	| CliConfigNotFoundError
	| CliConfigInvalidError
	| CliUnavailableError
	| CliSnapshotNotFoundError
	| CliConfirmRequiredError
	| CliSupervisorLiveError
	| CliNoSupervisorError
	| CliInternalError
	| CliAlreadyReportedError;

export const isCliError = (value: unknown): value is CliError => {
	if (typeof value !== 'object' || value === null) return false;
	const tag = (value as { readonly _tag?: unknown })._tag;
	switch (tag) {
		case 'CliUsageError':
		case 'CliConfigNotFoundError':
		case 'CliConfigInvalidError':
		case 'CliUnavailableError':
		case 'CliSnapshotNotFoundError':
		case 'CliConfirmRequiredError':
		case 'CliSupervisorLiveError':
		case 'CliNoSupervisorError':
		case 'CliInternalError':
		case 'CliAlreadyReportedError':
			return true;
		default:
			return false;
	}
};

/** Project a tagged error to its sysexit code. The dispatcher reads
 *  this to set `process.exitCode` — there is exactly one place in the
 *  surface where tag → numeric mapping happens. */
export const exitCodeFor = (error: CliError): ExitCode => {
	switch (error._tag) {
		case 'CliUsageError':
			return XC.USAGE;
		case 'CliConfigNotFoundError':
			return XC.NO_INPUT;
		case 'CliConfigInvalidError':
			return XC.CONFIG;
		case 'CliUnavailableError':
			return XC.UNAVAILABLE;
		case 'CliSnapshotNotFoundError':
			return XC.SNAPSHOT_NOT_FOUND;
		case 'CliConfirmRequiredError':
			return XC.CONFIRM_REQUIRED;
		case 'CliSupervisorLiveError':
			return XC.SUPERVISOR_LIVE;
		case 'CliNoSupervisorError':
			return XC.UNAVAILABLE;
		case 'CliInternalError':
			return XC.SOFTWARE;
		case 'CliAlreadyReportedError':
			return error.exitCode;
		default: {
			const _exhaustive: never = error;
			void _exhaustive;
			return XC.SOFTWARE;
		}
	}
};

/** Short single-line summary for the envelope's `error.summary`
 *  field. Cascade detail lives in `error.chain[]`. */
export const summaryFor = (error: CliError): string => {
	switch (error._tag) {
		case 'CliUsageError':
			return error.message;
		case 'CliConfigNotFoundError':
			return error.message;
		case 'CliConfigInvalidError':
			return error.message;
		case 'CliUnavailableError':
			return `${error.service} unavailable: ${error.message}`;
		case 'CliSnapshotNotFoundError':
			return `snapshot not found: ${error.snapshotRef}`;
		case 'CliConfirmRequiredError':
			return `${error.verb} requires --yes (stdin is not a TTY or --no-input is set)`;
		case 'CliSupervisorLiveError':
			return `supervisor live for ${error.app}/${error.stack}`;
		case 'CliNoSupervisorError':
			return `no supervisor running for ${error.app}/${error.stack}`;
		case 'CliInternalError':
			return error.message;
		case 'CliAlreadyReportedError':
			return '(already reported)';
		default: {
			const _exhaustive: never = error;
			void _exhaustive;
			return '(unknown error)';
		}
	}
};

/** Optional hint for the envelope's `error.hint` field. */
export const hintFor = (error: CliError): string | undefined => {
	switch (error._tag) {
		case 'CliUsageError':
			return error.hint;
		case 'CliUnavailableError':
		case 'CliConfirmRequiredError':
		case 'CliSupervisorLiveError':
		case 'CliNoSupervisorError':
			return error.hint;
		case 'CliConfigNotFoundError':
		case 'CliConfigInvalidError':
		case 'CliSnapshotNotFoundError':
		case 'CliInternalError':
		case 'CliAlreadyReportedError':
			return undefined;
		default: {
			const _exhaustive: never = error;
			void _exhaustive;
			return undefined;
		}
	}
};
