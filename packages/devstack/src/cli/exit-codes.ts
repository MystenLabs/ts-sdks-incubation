// Sysexits-style exit code table for the CLI.
//
// BSD's `sysexits.h` carved out the 64-78 range for "common usage
// errors". Modern agent-friendly CLIs (gh, doctl, sops, sentry-cli)
// adopt the same convention so callers can branch on exit code without
// scraping stderr.
//
// Plus a devstack-domain 40-49 block for invariants the operator can
// act on (e.g. live-supervisor refusal, snapshot-not-found,
// seed-mismatch — see `notes/cli-redesign.md` §4.5).
//
// Phase A is additive — these codes are emitted in the envelope's
// `error.exitCode` field, but `cli/main.ts`'s teardown still maps every
// non-success to 1 unless the per-command flow surfaces a specific
// code. Phase B threads the codes through the top-level reporter.

/** Sysexits-style exit codes (BSD `sysexits.h`-derived) plus the
 *  devstack-domain 40-49 block. */
export const EX_OK = 0 as const;
/** Catch-all internal error. */
export const EX_GENERIC = 1 as const;
/** Bad flag, missing required positional argument, mutually exclusive
 *  flags, ambiguous snapshot ref, `--no-input` without `--yes`. */
export const EX_USAGE = 64 as const;
/** Malformed input data — seed-manifest decoding, manifest shape, bad
 *  JSON in a config the user supplied. */
export const EX_DATAERR = 65 as const;
/** Required input file / config / manifest doesn't exist. */
export const EX_NOINPUT = 66 as const;
/** Required upstream is unavailable: docker daemon down, RPC upstream
 *  unreachable in `fork apply`, traefik can't bind. */
export const EX_UNAVAILABLE = 69 as const;
/** Can't create an output: state-dir not writable, atomic-write failed,
 *  snapshot dir lacks permission. */
export const EX_CANTCREAT = 73 as const;
/** Transient failure — port collision, transient docker hiccup. Agents
 *  should retry these (with backoff). */
export const EX_TEMPFAIL = 75 as const;
/** Semantic config error: invalid `--upstream`, unrecognised network,
 *  forbidden flag combination. Distinct from `EX_DATAERR` (which is
 *  about file SHAPE — `EX_CONFIG` is about VALUE). */
export const EX_CONFIG = 78 as const;

/** Devstack domain 40-49 block. */
/** Refused because a supervisor holds the lock (mutating a live stack). */
export const EX_SUPERVISOR_LIVE = 40 as const;
/** Snapshot ref couldn't be resolved (restore/delete). */
export const EX_SNAPSHOT_NOT_FOUND = 41 as const;
/** `fork seed verify` mismatch — used by CI to gate on config drift. */
export const EX_SEED_MISMATCH = 42 as const;
/** Confirmation required (Tier 1/2 prompt) but `--no-input` was set. */
export const EX_CONFIRM_REQUIRED = 43 as const;

/** Union of every code the CLI may emit. */
export type ExitCode =
	| typeof EX_OK
	| typeof EX_GENERIC
	| typeof EX_USAGE
	| typeof EX_DATAERR
	| typeof EX_NOINPUT
	| typeof EX_UNAVAILABLE
	| typeof EX_CANTCREAT
	| typeof EX_TEMPFAIL
	| typeof EX_CONFIG
	| typeof EX_SUPERVISOR_LIVE
	| typeof EX_SNAPSHOT_NOT_FOUND
	| typeof EX_SEED_MISMATCH
	| typeof EX_CONFIRM_REQUIRED;

/** Human-readable name for every numeric code. Used by the schema
 *  emitter and by tests that assert on the documented mapping. */
export const exitCodeName = (code: ExitCode): string => {
	switch (code) {
		case EX_OK:
			return 'EX_OK';
		case EX_GENERIC:
			return 'EX_GENERIC';
		case EX_USAGE:
			return 'EX_USAGE';
		case EX_DATAERR:
			return 'EX_DATAERR';
		case EX_NOINPUT:
			return 'EX_NOINPUT';
		case EX_UNAVAILABLE:
			return 'EX_UNAVAILABLE';
		case EX_CANTCREAT:
			return 'EX_CANTCREAT';
		case EX_TEMPFAIL:
			return 'EX_TEMPFAIL';
		case EX_CONFIG:
			return 'EX_CONFIG';
		case EX_SUPERVISOR_LIVE:
			return 'EX_SUPERVISOR_LIVE';
		case EX_SNAPSHOT_NOT_FOUND:
			return 'EX_SNAPSHOT_NOT_FOUND';
		case EX_SEED_MISMATCH:
			return 'EX_SEED_MISMATCH';
		case EX_CONFIRM_REQUIRED:
			return 'EX_CONFIRM_REQUIRED';
	}
};

/** One-line description for each code (surfaced by `--schema --json`). */
export const exitCodeDescription = (code: ExitCode): string => {
	switch (code) {
		case EX_OK:
			return 'Success';
		case EX_GENERIC:
			return 'Unexpected internal error';
		case EX_USAGE:
			return 'Bad flags, missing required argument, or non-interactive without --yes';
		case EX_DATAERR:
			return 'Malformed input data (config, manifest, seed)';
		case EX_NOINPUT:
			return 'Required input file or manifest not found';
		case EX_UNAVAILABLE:
			return 'Required upstream unavailable (docker daemon down, RPC unreachable)';
		case EX_CANTCREAT:
			return 'Cannot create output (state-dir not writable, atomic-write failed)';
		case EX_TEMPFAIL:
			return 'Transient failure (port collision, network blip) — safe to retry';
		case EX_CONFIG:
			return 'Semantic config error (invalid value, forbidden combination)';
		case EX_SUPERVISOR_LIVE:
			return 'Refused: a live supervisor holds the lock for this stack';
		case EX_SNAPSHOT_NOT_FOUND:
			return 'No snapshot matched the supplied id or label';
		case EX_SEED_MISMATCH:
			return 'fork seed verify: on-disk meta differs from the supplied config';
		case EX_CONFIRM_REQUIRED:
			return 'Interactive confirmation required but --no-input was set';
	}
};

/** Every code the CLI may emit. Iteration order is documented. */
export const ALL_EXIT_CODES: ReadonlyArray<ExitCode> = [
	EX_OK,
	EX_GENERIC,
	EX_USAGE,
	EX_DATAERR,
	EX_NOINPUT,
	EX_UNAVAILABLE,
	EX_CANTCREAT,
	EX_TEMPFAIL,
	EX_CONFIG,
	EX_SUPERVISOR_LIVE,
	EX_SNAPSHOT_NOT_FOUND,
	EX_SEED_MISMATCH,
	EX_CONFIRM_REQUIRED,
];
