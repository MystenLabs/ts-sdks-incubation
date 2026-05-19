// `wrapDocker` — combinator that converts a `DockerError` failure into a
// plugin-specific tagged error.
//
// Why centralize: ~25 sites across `services/*/internal.ts` repeat the
// same five-line `Effect.catchTag('DockerError', cause => Effect.fail(new
// XError({ phase, message, cause })))` boilerplate after every Docker
// primitive call (`Docker.run`, `Docker.exec`, `Docker.build`, …). The
// repetition has two costs:
//
//   1. Each call site has to remember to wire `cause: cause` (otherwise
//      `pretty-error.ts` loses the underlying docker exit-code +
//      stdout/stderr and the supervisor's TUI surfaces a bare phase
//      string instead of "docker exec ... exit 137 stderr: ...").
//   2. Adding a new field to a plugin's TaggedError (e.g. a `component`
//      discriminator, the most recent `marginAsset` on deepbook) means
//      hand-editing every wrap site instead of one factory closure.
//
// Shape: `wrapDocker(makeError)` returns a `pipe`-compatible combinator
// that swaps the `DockerError` failure channel for whatever `makeError`
// builds. Plugin authors keep ownership of the destination error's
// shape (which TaggedError class to construct, which fields to fill);
// the helper only takes care of the catch-tag plumbing.
//
// Usage:
//   Docker.exec(id, 'psql', [...]).pipe(
//     wrapDocker((cause) => new PostgresError({
//       phase: 'createdb',
//       database: dbName,
//       message: 'psql exec (existence check) failed',
//       cause,
//     })),
//   );
//
// For sites that emit multiple `catchTag` branches (e.g. `'DockerError'`
// + `'ReadyProbeError'`), use `wrapDocker(...)` for the Docker branch
// only and keep the others as plain `Effect.catchTag(...)` calls.

import { Effect } from 'effect';
import { DockerError } from '../errors.js';

/** Convert a `DockerError` failure into `E` via `makeError(cause)`.
 *  Pipe-compatible — drop into an `.pipe(...)` chain after any Effect
 *  that can fail with `DockerError`. */
export const wrapDocker =
	<E>(
		makeError: (cause: DockerError) => E,
	): (<A, R>(eff: Effect.Effect<A, DockerError, R>) => Effect.Effect<A, E, R>) =>
	<A, R>(eff: Effect.Effect<A, DockerError, R>): Effect.Effect<A, E, R> =>
		eff.pipe(Effect.catchTag('DockerError', (cause) => Effect.fail(makeError(cause))));
