// Internal state store. Keyed by string, holds arbitrary JSON.
// File-backed: reads the state file at scope acquire, writes atomically
// on every put/remove. Survives across runs so plugin state (published
// package IDs, etc.) doesn't need re-publishing on every dev cycle.
//
// Path scoping (mirrors v3 `packages/devstack/src/persistence/paths.ts`):
//   - localnet:                       <appDir>/.devstack/stacks/<stack>/state.json
//   - testnet / mainnet / devnet / …: <appDir>/.devstack/networks/<network>.json
//
//   appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd()
//
// `DEVSTACK_STATE_DIR` env still wins as a legacy escape hatch — the
// file lives at `${DEVSTACK_STATE_DIR}/state.json` ignoring stack/network.
//
// Multi-process safety:
//   - Writes are atomic: write `state.json.tmp.<pid>.<time>.<rand>` then rename.
//   - Exclusive PID-aware lock at `<dir>/state.json.lock`. Created with `wx`
//     (O_EXCL); contains `{pid, startedAt, acquiredAt, host, instanceId}`.
//     If a competing lock exists and its holder is still alive (`process.kill
//     (pid, 0)` plus `ps -o lstart=` match on POSIX for PID-reuse defense),
//     we fail with `StateStoreLockedError`. Stale locks (dead PID or mismatched
//     start time) are reclaimed via tempfile+rename, using a per-attempt
//     `instanceId` UUID to disambiguate concurrent reclaim races.
//   - Lock release on Scope finalizer (only if `instanceId` still matches).
//   - PID liveness check is portable: on Windows we use `tasklist` to detect
//     existence but skip the start-time match (PID reuse on Windows is
//     a known v1 trade-off); on POSIX we use `ps -o lstart=`. `EPERM` from
//     `process.kill(pid, 0)` is treated as alive (cross-user processes).
//
// Schema versioning:
//   Persisted shape is `{version: 1, data: {...}}`. Legacy files (no
//   `version` key) are auto-migrated by rewrapping. Higher versions fail
//   loudly with a migration-needed error.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, PlatformError, Ref, Schema } from 'effect';
import type { SuiNetwork } from '../primitives/sui.js';
import { jsonBigintReplacer, jsonBigintReviver } from './json-bigint.js';

export interface StateStoreShape {
	readonly get: <T = unknown>(key: string) => Effect.Effect<Option.Option<T>>;
	readonly put: <T>(key: string, value: T) => Effect.Effect<void>;
	readonly remove: (key: string) => Effect.Effect<void>;
}

export class StateStore extends Context.Service<StateStore, StateStoreShape>()(
	'@devstack/StateStore',
) {}

// -----------------------------------------------------------------------------
// StateStoreConfig — provided by `define-devstack.ts`. Holds the resolved
// stack/network identity plus an optional explicit state dir override.
// -----------------------------------------------------------------------------

export interface StateStoreConfigShape {
	readonly stack: string;
	readonly network: SuiNetwork;
	/** When set, overrides path scoping (legacy `DEVSTACK_STATE_DIR` behavior). */
	readonly stateDir?: string;
}

export class StateStoreConfig extends Context.Service<StateStoreConfig, StateStoreConfigShape>()(
	'@devstack/StateStoreConfig',
) {}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class StateStoreLockedError extends Schema.TaggedErrorClass<StateStoreLockedError>()(
	'StateStoreLockedError',
	{
		path: Schema.String,
		holderPid: Schema.Number,
		holderStartedAt: Schema.optional(Schema.String),
		message: Schema.String,
	},
) {}

export class StateStoreMigrationError extends Schema.TaggedErrorClass<StateStoreMigrationError>()(
	'StateStoreMigrationError',
	{
		path: Schema.String,
		foundVersion: Schema.Number,
		expectedVersion: Schema.Number,
		message: Schema.String,
	},
) {}

// -----------------------------------------------------------------------------
// Persisted shape
// -----------------------------------------------------------------------------

const CURRENT_VERSION = 1;

// Persisted file shape: `{ version: 1, data: { ...key/value pairs } }`.
// Declared for documentation — raw JSON.parse is used at runtime to keep
// the BigInt-tagging reviver in play.
export const PersistedDataSchema = Schema.Record(Schema.String, Schema.Unknown);
export const PersistedFileSchema = Schema.Struct({
	version: Schema.Number,
	data: PersistedDataSchema,
});

// -----------------------------------------------------------------------------
// Path resolution
// -----------------------------------------------------------------------------

interface ResolvedPaths {
	readonly dir: string;
	readonly file: string;
	readonly lock: string;
}

const resolvePaths = (cfg: StateStoreConfigShape): ResolvedPaths => {
	// Legacy escape hatch — explicit override wins. The historical layout
	// is `${stateDir}/state.json` regardless of stack/network.
	const envOverride = process.env.DEVSTACK_STATE_DIR;
	if (envOverride !== undefined && envOverride.length > 0) {
		return {
			dir: envOverride,
			file: join(envOverride, 'state.json'),
			lock: join(envOverride, 'state.json.lock'),
		};
	}
	if (cfg.stateDir !== undefined && cfg.stateDir.length > 0) {
		return {
			dir: cfg.stateDir,
			file: join(cfg.stateDir, 'state.json'),
			lock: join(cfg.stateDir, 'state.json.lock'),
		};
	}

	const appDir = process.env.DEVSTACK_APP_DIR ?? process.cwd();
	if (cfg.network === 'localnet') {
		const dir = join(appDir, '.devstack', 'stacks', cfg.stack);
		return {
			dir,
			file: join(dir, 'state.json'),
			lock: join(dir, 'state.json.lock'),
		};
	}
	// Live nets — one record per network, no stack dimension.
	const dir = join(appDir, '.devstack', 'networks');
	return {
		dir,
		file: join(dir, `${cfg.network}.json`),
		lock: join(dir, `${cfg.network}.lock`),
	};
};

// -----------------------------------------------------------------------------
// Lock helpers
// -----------------------------------------------------------------------------

interface LockBody {
	readonly pid: number;
	readonly startedAt: string;
	readonly acquiredAt: string;
	readonly host: string;
	/** Per-attempt UUID. Lets concurrent reclaimers disambiguate after rename(). */
	readonly instanceId: string;
}

// PID-reuse defense: best-effort start-time read for `pid`. POSIX uses
// `ps -o lstart=`; Windows uses `tasklist` (which only confirms existence —
// PID reuse on Windows is a known v1 trade-off). Returns undefined if the
// process is gone or the platform can't supply a start time. `execFileSync`
// is fine here — lookups are rare (only when a lock file already exists at
// acquire time) and bounded in cost.
const processStartTime = (pid: number): string | undefined => {
	if (process.platform === 'win32') {
		// `tasklist` confirms existence but doesn't expose start time in the
		// default columns. Return undefined to signal "alive-but-no-stamp"
		// so callers fall back to the `kill(0)` check.
		try {
			const out = execFileSync(
				'tasklist',
				['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
				{
					encoding: 'utf8',
					timeout: 2000,
					stdio: ['ignore', 'pipe', 'ignore'],
				},
			);
			// `tasklist` prints "INFO: No tasks..." on stdout when no match.
			return out.trim().startsWith('"') ? '' : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			encoding: 'utf8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
};

const isHolderLive = (holder: LockBody): boolean => {
	// `process.kill(pid, 0)` is the canonical "is this process alive?"
	// check on POSIX — it sends no signal and throws ESRCH if absent.
	// On Node it also surfaces EPERM when the target is owned by another
	// user, which still proves the PID is in use — treat as alive.
	try {
		process.kill(holder.pid, 0);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EPERM') return true;
		// ESRCH (or anything else like an exotic error) — assume dead.
		return false;
	}
	// Alive AND we have permission. Confirm start-time match if both sides
	// have a stamp to compare. On Windows (`tasklist` returns '' on hit)
	// or for legacy lock files (empty `startedAt`) we trust kill(0).
	const live = processStartTime(holder.pid);
	if (live === undefined) {
		// Process disappeared between kill(0) and ps — race; treat as dead.
		return false;
	}
	if (live === '' || holder.startedAt === '') return true;
	return live === holder.startedAt;
};

const parseLockBody = (raw: string): LockBody | undefined => {
	try {
		const parsed = JSON.parse(raw) as Partial<LockBody>;
		if (typeof parsed.pid !== 'number') return undefined;
		return {
			pid: parsed.pid,
			startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
			acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
			host: typeof parsed.host === 'string' ? parsed.host : '',
			instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : '',
		};
	} catch {
		return undefined;
	}
};

// -----------------------------------------------------------------------------
// Live layer
// -----------------------------------------------------------------------------

export const StateStoreLive: Layer.Layer<StateStore, StateStoreLockedError, FileSystem.FileSystem | StateStoreConfig> = Layer.effect(
	StateStore,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const cfg = yield* StateStoreConfig;
		const paths = resolvePaths(cfg);

		// Ensure the containing dir exists before any lock / write op.
		yield* fs
			.makeDirectory(paths.dir, { recursive: true })
			.pipe(Effect.catch(() => Effect.void));

		// Best-effort tighten of any pre-existing state file written by an older
		// devstack run with a permissive umask. chmod is a no-op on Windows /
		// some filesystems, so swallow failures.
		yield* fs
			.exists(paths.file)
			.pipe(
				Effect.flatMap((present) =>
					present
						? fs.chmod(paths.file, 0o600).pipe(Effect.catch(() => Effect.void))
						: Effect.void,
				),
				Effect.catch(() => Effect.void),
			);

		// --- Lock acquisition ---------------------------------------------------

		// Build a holder body for each attempt. The `instanceId` UUID is
		// regenerated per attempt so concurrent stale-lock reclaimers can
		// prove ownership after the tempfile+rename race (see below).
		const ownStartedAt = processStartTime(process.pid) ?? '';
		const ownAcquiredAt = new Date().toISOString();
		const ownHost = hostname();
		const buildOwnBody = (): LockBody => ({
			pid: process.pid,
			startedAt: ownStartedAt,
			acquiredAt: ownAcquiredAt,
			host: ownHost,
			instanceId: randomUUID(),
		});

		const serializeBody = (body: LockBody): string =>
			`${JSON.stringify(body, null, 2)}\n`;

		const readExistingHolder = (): Effect.Effect<LockBody | undefined> =>
			fs.readFileString(paths.lock).pipe(
				Effect.map((raw) => parseLockBody(raw)),
				Effect.catch(() => Effect.succeed<LockBody | undefined>(undefined)),
			);

		const failLocked = (holder: LockBody | undefined) => {
			const pid = holder?.pid ?? -1;
			// Multi-line block: the framed actions matter more than the
			// raw pid + path. SIGINT first (graceful), then a manual
			// `kill -TERM` for the case the user's running supervisor is
			// stuck and Ctrl-C isn't an option (separate terminal, lost
			// foreground, etc.).
			const lines = [
				`devstack: stack '${cfg.stack}' (${cfg.network}) is already running` +
					` (pid ${pid}${holder?.startedAt ? `, started ${holder.startedAt}` : ''}).`,
				'',
				'To recover:',
				`  1. Find the running supervisor:    ps -p ${pid}`,
				`  2. Stop it gracefully:             kill -TERM ${pid}`,
				`     (or press Ctrl-C in that terminal)`,
				`  3. If that process is already dead, remove the stale lock:`,
				`        rm ${paths.lock}`,
				'',
				'Two supervisors against the same stack will fight over container',
				'state, ports, and the Sui chain — refusing is safer than racing.',
			];
			return Effect.fail(
				new StateStoreLockedError({
					path: paths.lock,
					holderPid: pid,
					...(holder?.startedAt ? { holderStartedAt: holder.startedAt } : {}),
					message: lines.join('\n'),
				}),
			);
		};

		// Atomic claim protocol:
		//   1. Build a holder body with a fresh `instanceId`.
		//   2. `writeFileString(lock, body, {flag: 'wx'})` — O_EXCL create.
		//      Success → we own the lock.
		//   3. On EEXIST: read the existing holder. If alive → fail loudly.
		//   4. Stale: write our body to `lock.tmp.<pid>.<rand>` then
		//      `rename(tmp, lock)` (POSIX rename atomically overwrites the
		//      destination — `wx` is _not_ safe between remove + create here).
		//      Read the lock back and compare `instanceId`. If it matches
		//      ours, we own it. Otherwise another reclaimer beat us — retry
		//      the protocol from step 1.
		//
		// Bounded retry count keeps a thundering herd of stale-lock
		// reclaimers from looping forever in pathological cases.
		const MAX_RECLAIM_ATTEMPTS = 5;
		let acquiredBody: LockBody | undefined;
		for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
			const body = buildOwnBody();
			const serialized = serializeBody(body);

			const exclusive = yield* fs
				.writeFileString(paths.lock, serialized, { flag: 'wx' })
				.pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
			if (exclusive) {
				acquiredBody = body;
				break;
			}

			const existing = yield* readExistingHolder();
			if (existing && isHolderLive(existing)) {
				return yield* failLocked(existing);
			}

			// Stale lock — reclaim via tempfile + rename. The rename itself
			// overwrites unconditionally, so the round-trip `instanceId`
			// check is what actually decides who won.
			const tmp = `${paths.lock}.tmp.${process.pid}.${randomUUID()}`;
			const wroteTmp = yield* fs.writeFileString(tmp, serialized).pipe(
				Effect.as(true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (!wroteTmp) {
				yield* fs.remove(tmp, { force: true }).pipe(Effect.catch(() => Effect.void));
				continue;
			}

			const renamed = yield* fs.rename(tmp, paths.lock).pipe(
				Effect.as(true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (!renamed) {
				yield* fs.remove(tmp, { force: true }).pipe(Effect.catch(() => Effect.void));
				continue;
			}

			const after = yield* readExistingHolder();
			if (after?.instanceId === body.instanceId) {
				acquiredBody = body;
				break;
			}
			// Another reclaimer's rename landed after ours — retry.
		}

		if (!acquiredBody) {
			const winner = yield* readExistingHolder();
			return yield* failLocked(winner);
		}

		// Capture for the finalizer — `ownBody` is the body whose
		// `instanceId` is currently on disk.
		const ownBody = acquiredBody;

		// Lock release on scope teardown. Only delete if our `instanceId`
		// is still in the file (defensive — another process may have
		// detected ours as stale and overwritten it during this run).
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const current = yield* readExistingHolder();
				if (current?.instanceId === ownBody.instanceId) {
					yield* fs
						.remove(paths.lock, { force: true })
						.pipe(Effect.catch(() => Effect.void));
				}
			}),
		);

		// --- Initial load -------------------------------------------------------

		// Read existing state if file exists, else start empty.
		// Schema-version check fails loudly for newer-than-current versions.
		// Legacy (un-versioned) files are auto-migrated by rewrapping.
		// All other read errors (IO, malformed JSON) collapse to an empty
		// map so a corrupt cache never blocks the dev stack from starting.
		const empty: Record<string, unknown> = {};
		const loadInitial: Effect.Effect<Record<string, unknown>, StateStoreMigrationError> = fs
			.exists(paths.file)
			.pipe(
				Effect.flatMap((exists) =>
					exists
						? fs.readFileString(paths.file).pipe(
								Effect.flatMap((txt) =>
									Effect.gen(function* () {
										const parsed = yield* Effect.try({
											try: () => JSON.parse(txt, jsonBigintReviver) as unknown,
											catch: (cause) => cause,
										}).pipe(Effect.catch(() => Effect.succeed<unknown>(empty)));

										// Legacy: bare record, no `version` wrapper. Treat as v1
										// payload and rewrap on next write.
										if (
											parsed !== null &&
											typeof parsed === 'object' &&
											!('version' in (parsed as object))
										) {
											return parsed as Record<string, unknown>;
										}

										if (
											parsed !== null &&
											typeof parsed === 'object' &&
											'version' in (parsed as object) &&
											'data' in (parsed as object)
										) {
											const { version, data } = parsed as {
												version: unknown;
												data: unknown;
											};
											if (typeof version !== 'number') return empty;
											if (version > CURRENT_VERSION) {
												return yield* Effect.fail(
													new StateStoreMigrationError({
														path: paths.file,
														foundVersion: version,
														expectedVersion: CURRENT_VERSION,
														message:
															`devstack state file at ${paths.file} is version ${version}, ` +
															`but this devstack only understands version ${CURRENT_VERSION}. ` +
															`Upgrade devstack or remove the file to start fresh.`,
													}),
												);
											}
											if (data === null || typeof data !== 'object') return empty;
											return data as Record<string, unknown>;
										}

										return empty;
									}),
								),
							)
						: Effect.succeed(empty),
				),
				// Swallow all errors except the migration-needed one. We
				// detect it by tag so a corrupt-cache fallback doesn't
				// mask a real version mismatch.
				Effect.catch((err) =>
					err instanceof StateStoreMigrationError
						? Effect.fail(err)
						: Effect.succeed(empty),
				),
			);

		const initial = yield* loadInitial.pipe(Effect.orDie);

		const ref = yield* Ref.make<Map<string, unknown>>(new Map(Object.entries(initial)));

		// --- Atomic write -------------------------------------------------------

		// `persist` writes the current in-memory map to disk via tempfile +
		// rename. Errors are surfaced as Effect failures here; the public
		// `put` / `remove` operations downgrade them to a warning log
		// (they've already mutated the Ref — failing the call would lie
		// about the in-memory state).
		const persist: Effect.Effect<void, PlatformError.PlatformError> = Effect.gen(function* () {
			const m = yield* Ref.get(ref);
			const data = Object.fromEntries(m);
			const body = JSON.stringify(
				{ version: CURRENT_VERSION, data },
				jsonBigintReplacer,
				2,
			);
			// Tempfile name carries pid+time+random so two writers in the
			// same process (concurrent put/remove inside this layer) plus
			// any cross-process writer with the same pid space never
			// collide on the temp path.
			const tmp = `${paths.file}.tmp.${process.pid}.${Date.now()}.${Math.random()
				.toString(36)
				.slice(2, 10)}`;
			// acquire = write tmp; use = rename(tmp -> file). On the
			// success path the tmp file no longer exists after rename, so
			// `remove(tmp)` only runs in `release` when `use` failed.
			yield* Effect.acquireUseRelease(
				fs.writeFileString(tmp, body),
				() => fs.rename(tmp, paths.file),
				(_, exit) =>
					exit._tag === 'Failure'
						? fs.remove(tmp, { force: true }).pipe(Effect.catch(() => Effect.void))
						: Effect.void,
			);
			// Best-effort — chmod is a no-op on Windows / some filesystems.
			yield* fs.chmod(paths.file, 0o600).pipe(Effect.catch(() => Effect.void));
		});

		// Run `persist` and log any failure as a warning. Used by the
		// public `put` / `remove` ops so a failing disk doesn't crash
		// callers — but unlike the previous silent-swallow behavior we
		// at least surface the cause via the logger.
		const persistAndWarn: Effect.Effect<void> = persist.pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning('state-store: persist failed', cause),
			),
		);

		return {
			get: <T>(key: string) =>
				Ref.get(ref).pipe(
					Effect.map((m) => (m.has(key) ? Option.some(m.get(key) as T) : Option.none<T>())),
				),
			put: <T>(key: string, value: T) =>
				Ref.update(ref, (m) => new Map(m).set(key, value)).pipe(Effect.andThen(persistAndWarn)),
			remove: (key: string) =>
				Ref.update(ref, (m) => {
					const next = new Map(m);
					next.delete(key);
					return next;
				}).pipe(Effect.andThen(persistAndWarn)),
		};
	}),
);
