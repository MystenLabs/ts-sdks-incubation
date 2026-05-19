// `wrapDocker` swaps the DockerError failure channel for a
// plugin-specific tagged error. A regression here breaks the typed-catch
// recovery branches that downstream consumers (pretty-error, supervisor)
// rely on — silent re-tag would surface DockerError verbatim from a
// service that promised PostgresError, etc.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { DockerError } from '../errors.js';
import { wrapDocker } from './wrap.js';

class FakeError extends Schema.TaggedErrorClass<FakeError>()('FakeError', {
	phase: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {}

describe('wrapDocker', () => {
	it('passes the success channel through unchanged', () =>
		Effect.gen(function* () {
			const out = yield* Effect.succeed(42).pipe(
				wrapDocker((cause) => new FakeError({ phase: 'p', message: cause.message })),
			);
			expect(out).toBe(42);
		}).pipe(Effect.runPromise));

	it('converts a DockerError failure into the plugin-specific error', () =>
		Effect.gen(function* () {
			const docker = Effect.fail(
				new DockerError({
					phase: 'docker pull',
					message: 'image not found',
					exitCode: 1,
				}),
			);
			const result = yield* docker
				.pipe(
					wrapDocker(
						(cause) =>
							new FakeError({
								phase: 'image-pull',
								message: `wrapped: ${cause.message}`,
								cause,
							}),
					),
				)
				.pipe(Effect.flip);
			expect(result._tag).toBe('FakeError');
			expect(result.phase).toBe('image-pull');
			expect(result.message).toBe('wrapped: image not found');
			expect((result.cause as DockerError).exitCode).toBe(1);
		}).pipe(Effect.runPromise));

	it('threads the original DockerError as `cause` for pretty-error chaining', () =>
		Effect.gen(function* () {
			const original = new DockerError({
				phase: 'docker exec',
				message: 'oops',
				stdout: 'out',
				stderr: 'err',
				exitCode: 2,
			});
			const result = yield* Effect.fail(original)
				.pipe(
					wrapDocker(
						(cause) =>
							new FakeError({
								phase: 'wrap',
								message: 'wrapped',
								cause,
							}),
					),
				)
				.pipe(Effect.flip);
			// `cause` is preserved so the supervisor's pretty-error pass can
			// drill into the original stdout/stderr/exitCode.
			const cause = result.cause as DockerError;
			expect(cause).toBe(original);
			expect(cause.stdout).toBe('out');
			expect(cause.stderr).toBe('err');
		}).pipe(Effect.runPromise));

	it('matches the open-coded `Effect.catchTag` equivalence (referential parity)', () =>
		Effect.gen(function* () {
			// Pin the helper's semantics to the open-coded form so future
			// refactors that change the catch behavior (e.g. swapping for
			// catchTags or using mapError) trip this test.
			const docker = Effect.fail(new DockerError({ message: 'x' }));
			const open = yield* docker
				.pipe(
					Effect.catchTag('DockerError', (cause) =>
						Effect.fail(new FakeError({ phase: 'p', message: 'm', cause })),
					),
				)
				.pipe(Effect.flip);
			const wrapped = yield* docker
				.pipe(wrapDocker((cause) => new FakeError({ phase: 'p', message: 'm', cause })))
				.pipe(Effect.flip);
			expect(open._tag).toBe(wrapped._tag);
			expect(open.phase).toBe(wrapped.phase);
			expect(open.message).toBe(wrapped.message);
		}).pipe(Effect.runPromise));
});
