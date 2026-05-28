// Verb-wiring bail helpers — promote raw `process.stderr.write` +
// `process.exitCode = ...` shortcuts to typed `CliError` failures.
//
// Why this exists:
//   The dispatcher's outer `Effect.catch((error: CliError) =>
//   emitFailure(...))` in `surfaces/cli/index.ts` already knows how to
//   render a typed error AS a JSON envelope (when `--json`) or a human
//   stderr line (otherwise). Wirings that bypass the typed-error path
//   and write raw bytes to stderr break the JSON-envelope contract:
//   `devstack up --json` against a live supervisor would emit raw
//   `error: supervisor live for <app>/<stack>\n` text on stderr instead
//   of a structured `{ok:false, error.code:'SUPERVISOR_LIVE'}` envelope
//   on stdout. The fix is to surface the failure as
//   `Effect.fail(new CliSupervisorLiveError(...))` and let the
//   dispatcher's envelope renderer handle the projection.
//
// This module exists so the canonical pattern is one import + one
// function call, not a 6-line `Effect.fail(new …)` boilerplate at every
// bail site.

import { Cause, type Exit } from 'effect';

import {
	type CliConfigInvalidError,
	type CliConfigNotFoundError,
	type CliError,
	CliInternalError,
} from '../surfaces/cli/errors.ts';

/** Project a config-loader `Exit.Failure` cause to the typed `CliError`
 *  the dispatcher expects. The config loader fails with
 *  `CliConfigNotFoundError | CliConfigInvalidError`; defect paths (a
 *  thrown non-Error) bottom out at `CliInternalError`. */
export const cliErrorFromConfigExit = (
	exit: Exit.Exit<unknown, CliConfigNotFoundError | CliConfigInvalidError>,
): CliError => {
	if (exit._tag === 'Success') {
		// Caller-side contract: only invoke on failure. Defensive
		// fallback returns an internal error instead of throwing so a
		// misuse doesn't crash the dispatcher.
		return new CliInternalError({
			message: 'cliErrorFromConfigExit invoked on a successful exit',
		});
	}
	const fail = exit.cause.reasons.find(Cause.isFailReason);
	if (fail !== undefined) {
		const err = fail.error;
		if (err._tag === 'CliConfigNotFoundError' || err._tag === 'CliConfigInvalidError') {
			return err;
		}
	}
	return new CliInternalError({
		message: 'config load failed with an unexpected cause',
		cause: exit.cause,
	});
};
