// Postgres plugin — idempotent logical-database creation via
// `docker exec ... psql`.
//
// Why exec, not a TS pg client:
//   - Production path keeps a zero-runtime-dep posture (distilled doc
//     § Postgres-specific concerns: "avoids carrying a TS `pg` runtime
//     dependency in the production path").
//   - The probe binary already lives inside the image; the dev
//     machine doesn't need a libpq install.
//   - The same machinery serves `pg_isready` (readiness probe) and
//     `psql` (existence check + createdb), so one exec primitive
//     covers both side-channels.
//
// Idempotency contract:
//   - The first database is bootstrapped by the upstream image's
//     entrypoint via `POSTGRES_DB`. The plugin's acquire body MUST
//     skip it here — passing it through `ensureDatabase` is harmless
//     (we short-circuit on existence) but wastes a round-trip.
//   - Subsequent databases land via SELECT 1 / createdb. SELECT 1
//     against `pg_database WHERE datname = '<name>'` returns "1\n" on
//     hit; we treat any non-empty trimmed stdout as a hit so a
//     trailing newline doesn't trigger a duplicate-createdb path.
//
// The `ContainerExec` capability is consumed via the plugin's service
// body (`service.ts:containerExec`), which thin-wraps the
// `ContainerRuntime.exec` contract surface. Daemon-level failures
// project to a synthetic non-zero `ExecResult` so the retry loop
// observes them and the typed timeout error carries the captured
// streams.

import { Effect } from 'effect';

import {
	databaseCreateFailed,
	postgresConnectionTimeout,
	type DatabaseCreateFailed,
	type PostgresConnectionTimeout,
	type PostgresPluginError,
} from './errors.ts';
import { PostgresSpans } from './spans.ts';
import {
	ProbeTimeoutError,
	exitCodeProbeResult,
	waitForProbe,
} from '../../substrate/runtime/probes.ts';

/** One captured exec invocation. Mirrors the shape returned by
 *  `docker exec` (stdout + stderr + exit code), without naming docker
 *  — any container runtime that supports an exec primitive can
 *  satisfy this. */
export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Exec callable injected by the plugin's service body. Wraps
 *  `ContainerRuntime.exec` (see contract) into the local seam shape so
 *  the retry / existence-check loops here stay runtime-agnostic.
 *
 *  Daemon-level failures surface as `PostgresPluginError`; non-zero
 *  exit codes (eg `pg_isready` not ready yet) are returned in the
 *  `ExecResult` for the caller to interpret. */
export interface ContainerExec {
	readonly run: (
		argv: ReadonlyArray<string>,
	) => Effect.Effect<ExecResult, PostgresPluginError>;
}

const READY_PROBE_INTERVAL_MS = 500;

/** Wait until `pg_isready -U <user> -d <db>` exits zero or the
 *  overall deadline elapses.
 *
 *  Distilled doc § "Postgres-specific concerns" — server-aware probe;
 *  TCP-listener readiness alone is insufficient (postgres opens the
 *  port before it accepts queries). */
export const awaitReady = (
	exec: ContainerExec,
	user: string,
	database: string,
	timeoutMs: number,
): Effect.Effect<void, PostgresConnectionTimeout> =>
	Effect.gen(function* () {
		let attempts = 0;
		let lastResult: ExecResult | undefined;
		const startedAt = Date.now();

		return yield* waitForProbe({
			label: `postgres:${database}`,
			timeoutMs,
			intervalMs: READY_PROBE_INTERVAL_MS,
			probe: () =>
				Effect.gen(function* () {
					attempts += 1;
					const result = yield* exec.run(['pg_isready', '-U', user, '-d', database]);
					lastResult = result;
					return exitCodeProbeResult(result);
				}),
		}).pipe(
			Effect.mapError((cause) => {
				const lastError =
					cause instanceof ProbeTimeoutError ? cause.lastError : (cause as unknown);
				return postgresConnectionTimeout({
					database,
					attempts: cause instanceof ProbeTimeoutError ? cause.attempts : attempts,
					elapsedMs: Date.now() - startedAt,
					lastExitCode: lastResult?.exitCode,
					lastStdout: lastResult?.stdout,
					lastStderr: lastResult?.stderr,
					...(lastError === undefined ? {} : { lastError }),
				});
			}),
			Effect.withSpan('devstack.plugin.postgres.awaitReady', {
				attributes: {
					[PostgresSpans.database]: database,
					[PostgresSpans.timeoutMs]: timeoutMs,
				},
			}),
		);
	});

/** Idempotently ensure a logical database exists.
 *
 *  Algorithm:
 *    1. `psql -tAc "SELECT 1 FROM pg_database WHERE datname = '<db>'"`.
 *       Exit 0 + non-empty stdout => exists, return.
 *       Exit != 0                 => DatabaseCreateFailed(exists-check).
 *    2. `createdb -U <user> <db>`.
 *       Exit 0  => done.
 *       Exit != 0 => DatabaseCreateFailed(createdb).
 *
 *  Identifier quoting note: this implementation passes the database
 *  name as a CLI argument (createdb) and as a SQL string literal
 *  (the existence query). Postgres folds unquoted identifiers; if
 *  the caller passes `MyDB`, postgres stores it as `mydb`. The
 *  current plugin contract doesn't quote — distilled doc § Edge
 *  cases flags this as a known foot-gun, and the recommended cure
 *  is "use lowercase names". */
export const ensureDatabase = (
	exec: ContainerExec,
	user: string,
	dbName: string,
): Effect.Effect<void, DatabaseCreateFailed | PostgresPluginError> =>
	Effect.gen(function* () {
		// Quote-escape per SQL literal rules (double single-quotes inside
		// the literal). The plugin's own contract restricts callers to
		// lowercase database identifiers (see distilled-doc § Edge cases
		// above), but the literal interpolation here is still a foot-
		// gun: a name containing `'` would break the WHERE clause and
		// either fail the existence check or, worse, alter its
		// semantics. Escaping locks the wire shape independent of the
		// upstream contract.
		const escapedDbName = dbName.replace(/'/g, "''");
		const exists = yield* exec.run([
			'psql',
			'-U',
			user,
			'-tAc',
			`SELECT 1 FROM pg_database WHERE datname = '${escapedDbName}'`,
		]);
		if (exists.exitCode !== 0) {
			return yield* Effect.fail(
				databaseCreateFailed({
					database: dbName,
					op: 'exists-check',
					exitCode: exists.exitCode,
					stdout: exists.stdout,
					stderr: exists.stderr,
				}),
			);
		}
		if (exists.stdout.trim().length > 0) {
			return; // already present
		}

		const created = yield* exec.run(['createdb', '-U', user, dbName]);
		if (created.exitCode !== 0) {
			return yield* Effect.fail(
				databaseCreateFailed({
					database: dbName,
					op: 'createdb',
					exitCode: created.exitCode,
					stdout: created.stdout,
					stderr: created.stderr,
				}),
			);
		}
	}).pipe(
		Effect.withSpan('devstack.plugin.postgres.ensureDatabase', {
			attributes: { [PostgresSpans.database]: dbName },
		}),
	);

/** Sequentially ensure every non-bootstrap database exists. The
 *  bootstrap (first entry) is created by `POSTGRES_DB` at image
 *  entrypoint and MUST be skipped here. */
export const ensureDatabases = (
	exec: ContainerExec,
	user: string,
	databases: ReadonlyArray<string>,
): Effect.Effect<void, DatabaseCreateFailed | PostgresPluginError> =>
	Effect.gen(function* () {
		for (let i = 1; i < databases.length; i++) {
			yield* ensureDatabase(exec, user, databases[i]!);
		}
	});
