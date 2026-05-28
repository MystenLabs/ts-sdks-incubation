// Postgres plugin — typed errors.
//
// Per-plugin tagged errors (architecture § Effect; substrate-redesign
// directive: errors live with the plugin that raises and consumes
// them). Postgres is a topological leaf — every raise site AND every
// consumer is inside `src/plugins/postgres/`, so this file owns the
// complete error surface.
//
// Phase tags mirror the lifecycle states from the distilled doc
// (10-postgres § Lifecycle states): one phase per failure boundary
// so the cause walker / TUI / regression tests can pin behaviour by
// label rather than by message-substring matching.
//
// Effect v4: errors are plain interfaces with a `_tag` discriminator.
// `Effect.catchTag` / `catchTags` match on the `_tag` literal — we do
// NOT subclass an Effect base class. See architecture § Effect.

import { defineConfigError, type ConfigIssue } from '../../substrate/runtime/config-validation.ts';

/** Phases for `PostgresPluginError`. Closed sum — additions land in
 *  the distilled-doc catalog first. */
export type PostgresPhase =
	| 'network-create'
	| 'image-build'
	| 'container-start'
	| 'ready-probe'
	| 'db-ensure'
	| 'unknown';

/** Generic plugin error. Most failure surfaces collapse onto this
 *  shape; specific failure modes that warrant their own catchable
 *  tag (timeout, createdb-collision) get their own type below. */
export interface PostgresPluginError {
	readonly _tag: 'PostgresPluginError';
	readonly phase: PostgresPhase;
	readonly message: string;
	readonly cause?: unknown;
}

export const postgresPluginError = (
	phase: PostgresPhase,
	message: string,
	cause?: unknown,
): PostgresPluginError => ({ _tag: 'PostgresPluginError', phase, message, cause });

export interface PostgresConfigError extends ConfigIssue {
	readonly _tag: 'PostgresConfigError';
}

export const postgresConfigError = defineConfigError('PostgresConfigError');

/** `pg_isready` returned non-zero past the deadline. Carries the
 *  database name + last exit code + captured streams so the cause
 *  walker can render an actionable hint (slow disk, port mismatch,
 *  perms on data dir).
 *
 *  Distilled-doc § Edge cases: this is the most common "what went
 *  wrong" failure during first boot of a freshly-built image; it
 *  deserves its own tag so the renderer can show a slow-disk hint
 *  before users guess. */
export interface PostgresConnectionTimeout {
	readonly _tag: 'PostgresConnectionTimeout';
	readonly database: string;
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly lastExitCode?: number;
	readonly lastStdout?: string;
	readonly lastStderr?: string;
	/** Underlying typed error from the last probe attempt — populated
	 *  when the probe itself failed (eg daemon-level container-start
	 *  error) rather than `pg_isready` returning a non-zero exit. The
	 *  cause walker reads this to render the actionable hint. */
	readonly lastError?: unknown;
}

export const postgresConnectionTimeout = (
	parts: Omit<PostgresConnectionTimeout, '_tag'>,
): PostgresConnectionTimeout => ({ _tag: 'PostgresConnectionTimeout', ...parts });

/** Logical-database creation failed. Distinct from a network /
 *  container / probe failure because the typical root cause is
 *  case-sensitivity collision in postgres identifier folding —
 *  surfaced explicitly via its own tag so consumers can render a
 *  "quote the identifier" hint. */
export interface DatabaseCreateFailed {
	readonly _tag: 'DatabaseCreateFailed';
	readonly database: string;
	readonly op: 'exists-check' | 'createdb';
	readonly exitCode?: number;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly cause?: unknown;
}

export const databaseCreateFailed = (
	parts: Omit<DatabaseCreateFailed, '_tag'>,
): DatabaseCreateFailed => ({ _tag: 'DatabaseCreateFailed', ...parts });

/** Union of every error a Postgres-plugin caller may encounter. */
export type PostgresError =
	| PostgresPluginError
	| PostgresConfigError
	| PostgresConnectionTimeout
	| DatabaseCreateFailed;

/** Error tags this plugin contributes — surfaced to the cause walker
 *  via `PluginErrorContribution`. */
export const POSTGRES_ERROR_TAGS: ReadonlyArray<PostgresError['_tag']> = [
	'PostgresPluginError',
	'PostgresConfigError',
	'PostgresConnectionTimeout',
	'DatabaseCreateFailed',
] as const;
