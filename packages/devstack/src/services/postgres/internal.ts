// Postgres shared internals — image build constants, healthcheck probe,
// idempotent CREATE DATABASE helper.

import { Effect, Schedule } from 'effect';
import * as Docker from '../../engine/docker/index.js';
import { PostgresError } from '../../engine/errors.js';

/** Probe the postgres container with `docker exec <id> pg_isready -U <user>`
 *  until it reports `accepting connections` (exit 0). Exponential backoff
 *  capped at 2s. Total budget configurable; default 30s. */
const readyRetry = Schedule.exponential('100 millis', 1.5).pipe(
	Schedule.either(Schedule.spaced('2 seconds')),
);

export const awaitPostgresReady = (
	containerId: string,
	user: string,
	database: string,
	timeoutMs: number = 30_000,
): Effect.Effect<void, PostgresError, any> => {
	const attempt: Effect.Effect<void, PostgresError, any> = Effect.gen(function* () {
		const result = yield* Docker.exec(containerId, 'pg_isready', ['-U', user, '-d', database]).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new PostgresError({
						phase: 'ready',
						database,
						message: 'pg_isready exec failed',
						cause,
					}),
				),
			),
		);
		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new PostgresError({
					phase: 'ready',
					database,
					message: `pg_isready exit ${result.exitCode}`,
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				}),
			);
		}
	});
	return attempt.pipe(
		Effect.retry(readyRetry),
		Effect.timeoutOrElse({
			duration: `${timeoutMs} millis`,
			orElse: () =>
				Effect.fail(
					new PostgresError({
						phase: 'ready',
						database,
						message: `postgres container never became ready within ${timeoutMs}ms`,
					}),
				),
		}),
		Effect.withSpan('PostgresReady'),
	);
};

/** Create the named database if it doesn't already exist. Uses
 *  `docker exec <id> psql -U <user> -tc "SELECT 1 FROM pg_database WHERE datname='X'" | grep -q 1 || createdb -U <user> X`
 *  semantics — split into a SELECT + conditional createdb for cleaner
 *  error reporting. */
export const ensureDatabase = (
	containerId: string,
	user: string,
	dbName: string,
): Effect.Effect<void, PostgresError, any> =>
	Effect.gen(function* () {
		const exists = yield* Docker.exec(containerId, 'psql', [
			'-U',
			user,
			'-tAc',
			`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
		]).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new PostgresError({
						phase: 'createdb',
						database: dbName,
						message: 'psql exec (existence check) failed',
						cause,
					}),
				),
			),
		);
		if (exists.exitCode === 0 && exists.stdout.trim() === '1') {
			return; // already exists
		}
		const createResult = yield* Docker.exec(containerId, 'createdb', ['-U', user, dbName]).pipe(
			Effect.catchTag('DockerError', (cause) =>
				Effect.fail(
					new PostgresError({
						phase: 'createdb',
						database: dbName,
						message: 'createdb exec failed',
						cause,
					}),
				),
			),
		);
		if (createResult.exitCode !== 0) {
			return yield* Effect.fail(
				new PostgresError({
					phase: 'createdb',
					database: dbName,
					message: `createdb exit ${createResult.exitCode}`,
					stdout: createResult.stdout,
					stderr: createResult.stderr,
					exitCode: createResult.exitCode,
				}),
			);
		}
	}).pipe(Effect.withSpan('PostgresCreatedb'));
