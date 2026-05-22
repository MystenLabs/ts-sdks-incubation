// CLI surface — sysexits.h exit codes.
//
// Architecture (distilled/20-cli.md § Invariants) requires a single
// centralized table. Numbers are pinned, names are stable, new
// devstack-domain codes are added at the END of the domain block (so
// downstream scripts keying off numerics never shift).
//
// Reference: /usr/include/sysexits.h (BSD-derived). We use only the
// subset that maps to CLI failure shapes; everything else collapses to
// `EX_SOFTWARE` (70). The devstack-domain block (40-43) is a private
// extension carved out below the standard 64-78 range so it cannot
// collide with the OS table.
//
// Surface invariant: every CLI failure carries one of these codes in
// the JSON envelope's `error.exitCode` AND drives `process.exitCode`.
// "1 for everything" is explicitly disallowed by the architecture.

/** Sysexits-named exit codes (numeric values are stable; do NOT reuse). */
export const ExitCode = {
	/** Successful termination. */
	OK: 0,
	/** Generic catch-all failure. Use only when no specific code applies. */
	GENERIC: 1,
	/** Devstack-domain: supervisor for the target stack is already live
	 *  in another process. Destructive verbs refuse with this code. */
	SUPERVISOR_LIVE: 40,
	/** Devstack-domain: requested snapshot name / id not found. */
	SNAPSHOT_NOT_FOUND: 41,
	/** Devstack-domain: seed manifest mismatch between current chain
	 *  identity and the snapshot/seed being restored. */
	SEED_MISMATCH: 42,
	/** Devstack-domain: destructive verb requires explicit confirm but
	 *  `--no-input` / non-TTY / no `--yes` is in effect, or the
	 *  interactive prompt was declined. */
	CONFIRM_REQUIRED: 43,
	/** Bad usage (unknown flag, malformed args, mutually-exclusive
	 *  flag pair, ambiguous reference). */
	USAGE: 64,
	/** Input data malformed (config schema invalid, JSON parse error
	 *  inside a snapshot manifest, etc.). */
	DATA_ERR: 65,
	/** Cannot open input (config not found, snapshot file missing). */
	NO_INPUT: 66,
	/** Internal software error / unhandled defect. Default for
	 *  defects that escape Effect.catchAll. */
	SOFTWARE: 70,
	/** Service required by the CLI is unavailable (Docker daemon
	 *  unreachable, network down). */
	UNAVAILABLE: 69,
	/** Output file/directory cannot be created (permissions, disk
	 *  full). */
	CANT_CREATE: 73,
	/** Temporary failure; retry might succeed (lock contention,
	 *  transient daemon hiccup). */
	TEMP_FAIL: 75,
	/** Configuration error — the user's devstack.config.ts is wrong
	 *  in a way that prevents *any* verb from running. */
	CONFIG: 78,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Human-readable identifier for an exit code. Used by the
 *  `schema --json` command and by the envelope `error.code` field. */
export const exitCodeName = (code: ExitCode): string => {
	switch (code) {
		case ExitCode.OK:
			return 'OK';
		case ExitCode.GENERIC:
			return 'GENERIC';
		case ExitCode.SUPERVISOR_LIVE:
			return 'SUPERVISOR_LIVE';
		case ExitCode.SNAPSHOT_NOT_FOUND:
			return 'SNAPSHOT_NOT_FOUND';
		case ExitCode.SEED_MISMATCH:
			return 'SEED_MISMATCH';
		case ExitCode.CONFIRM_REQUIRED:
			return 'CONFIRM_REQUIRED';
		case ExitCode.USAGE:
			return 'USAGE';
		case ExitCode.DATA_ERR:
			return 'DATA_ERR';
		case ExitCode.NO_INPUT:
			return 'NO_INPUT';
		case ExitCode.SOFTWARE:
			return 'SOFTWARE';
		case ExitCode.UNAVAILABLE:
			return 'UNAVAILABLE';
		case ExitCode.CANT_CREATE:
			return 'CANT_CREATE';
		case ExitCode.TEMP_FAIL:
			return 'TEMP_FAIL';
		case ExitCode.CONFIG:
			return 'CONFIG';
	}
};

/** Schema-emit entry: full table of `(code, name, description)`. The
 *  programmable `schema --json` command serializes this verbatim. */
export interface ExitCodeEntry {
	readonly code: ExitCode;
	readonly name: string;
	readonly description: string;
}

export const exitCodeTable: ReadonlyArray<ExitCodeEntry> = [
	{ code: ExitCode.OK, name: 'OK', description: 'Successful termination.' },
	{
		code: ExitCode.GENERIC,
		name: 'GENERIC',
		description: 'Generic failure; no specific code applies.',
	},
	{
		code: ExitCode.SUPERVISOR_LIVE,
		name: 'SUPERVISOR_LIVE',
		description: 'Devstack: supervisor for the target stack is already live in another process.',
	},
	{
		code: ExitCode.SNAPSHOT_NOT_FOUND,
		name: 'SNAPSHOT_NOT_FOUND',
		description: 'Devstack: requested snapshot name or id not found.',
	},
	{
		code: ExitCode.SEED_MISMATCH,
		name: 'SEED_MISMATCH',
		description: 'Devstack: seed-manifest mismatch (chain identity diverges from snapshot).',
	},
	{
		code: ExitCode.CONFIRM_REQUIRED,
		name: 'CONFIRM_REQUIRED',
		description: 'Devstack: destructive verb needs confirmation or the prompt was declined.',
	},
	{ code: ExitCode.USAGE, name: 'USAGE', description: 'Bad command-line usage.' },
	{ code: ExitCode.DATA_ERR, name: 'DATA_ERR', description: 'Input data malformed.' },
	{ code: ExitCode.NO_INPUT, name: 'NO_INPUT', description: 'Required input could not be opened.' },
	{
		code: ExitCode.UNAVAILABLE,
		name: 'UNAVAILABLE',
		description: 'A required service (e.g. Docker daemon) is unavailable.',
	},
	{ code: ExitCode.SOFTWARE, name: 'SOFTWARE', description: 'Internal software error.' },
	{
		code: ExitCode.CANT_CREATE,
		name: 'CANT_CREATE',
		description: 'Cannot create output (permissions, disk).',
	},
	{
		code: ExitCode.TEMP_FAIL,
		name: 'TEMP_FAIL',
		description: 'Transient failure; retry may succeed.',
	},
	{ code: ExitCode.CONFIG, name: 'CONFIG', description: 'User configuration error.' },
];
