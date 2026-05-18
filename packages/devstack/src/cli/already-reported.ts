// Sentinel error subcommands raise after they've already printed a
// human-readable error to stderr. The CLI's top-level `tapCause` checks
// for this tag and skips its own pretty-error rendering, so the user
// sees one error, not two.
//
// The original cause is preserved on the sentinel for tooling that
// inspects causes (telemetry, future `--debug`).

import { Cause, Console, Effect, Schema } from 'effect';

export class AlreadyReportedError extends Schema.TaggedErrorClass<AlreadyReportedError>()(
	'AlreadyReportedError',
	{
		cause: Schema.Defect,
	},
) {}

/** Print `message` to stderr, then fail with `AlreadyReportedError`.
 *  Use this from CLI subcommands after a human-readable diagnostic has
 *  already been emitted — the top-level `tapCause` in `cli/index.ts`
 *  short-circuits its own rendering when it sees this sentinel, so the
 *  user sees one error, not two. */
export const failAlreadyReported = (message: string): Effect.Effect<never, AlreadyReportedError> =>
	Effect.gen(function* () {
		yield* Console.error(message);
		return yield* Effect.fail(new AlreadyReportedError({ cause: message }));
	});

/** Returns true if `cause` carries any `AlreadyReportedError` failure.
 *  Walks `cause.reasons` (the v4 flat-array model) and matches by
 *  tag so subcommand sentinels survive intermediate `Effect.fail`
 *  re-wrapping. */
export const causeHasAlreadyReported = (cause: Cause.Cause<unknown>): boolean => {
	for (const reason of cause.reasons) {
		if (!Cause.isFailReason(reason)) continue;
		const error = reason.error;
		if (
			typeof error === 'object' &&
			error !== null &&
			'_tag' in error &&
			(error as { _tag?: unknown })._tag === 'AlreadyReportedError'
		) {
			return true;
		}
	}
	return false;
};
