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

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, FileSystem, Layer, Option, PlatformError, Ref, Schema } from 'effect';
import type { SuiNetwork } from '../services/sui.js';
import { jsonBigintReplacer, jsonBigintReviver } from './json-bigint.js';
import { isHolderLive as isHolderLiveImpl, processStartTime } from './process-liveness.js';

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

// `processStartTime` and `isHolderLive` live in `process-liveness.ts`
// so doctor and any future consumers can reach for the same start-time-
// aware liveness check without re-implementing the cross-host /
// PID-reuse defense.
export const isHolderLive = (holder: LockBody): boolean => isHolderLiveImpl(holder);

const parseLockBody = (raw: string): LockBody | undefined => {
	try {
		const parsed = JSON.parse(raw) as Partial<LockBody>;
		// Tighten the pid check — `typeof parsed.pid === 'number'` accepts
		// `NaN` and `±Infinity` (both `'number'`) which would then crash
		// `process.kill` and force the reclaim loop to silently treat
		// the holder as dead. Require a finite positive integer.
		if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid) || parsed.pid <= 0) {
			return undefined;
		}
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

export const StateStoreLive: Layer.Layer<
	StateStore,
	StateStoreLockedError,
	FileSystem.FileSystem | StateStoreConfig
> = Layer.effect(
	StateStore,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const cfg = yield* StateStoreConfig;
		const paths = resolvePaths(cfg);

		// Ensure the containing dir exists before any lock / write op.
		yield* fs.makeDirectory(paths.dir, { recursive: true }).pipe(Effect.ignore);

		// Best-effort tighten of any pre-existing state file written by an older
		// devstack run with a permissive umask. chmod is a no-op on Windows /
		// some filesystems, so swallow failures.
		yield* fs.exists(paths.file).pipe(
			Effect.flatMap((present) =>
				present ? fs.chmod(paths.file, 0o600).pipe(Effect.ignore) : Effect.void,
			),
			Effect.ignore,
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

		const serializeBody = (body: LockBody): string => `${JSON.stringify(body, null, 2)}\n`;

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
		//   4. Stale: unlink the lock and loop. The next iteration's
		//      O_EXCL is the single source of truth — only one writer can
		//      win the kernel's create-new-file race. (Pre-fix the loop
		//      reclaimed via tempfile + rename + readback, but rename
		//      overwrites unconditionally and the readback could land
		//      between two peers' renames, letting both believe they
		//      owned the lock.)
		//
		// Bounded retry count + jittered backoff keeps a thundering herd
		// of stale-lock reclaimers from looping forever AND prevents the
		// pathological case where N peers all retry on the same tick.
		// Pre-fix: 5 attempts with no delay → legitimate stale-lock
		// recovery could fail when 3+ supervisors started simultaneously.
		// Now: 20 attempts with 50ms × 1.5^attempt × jitter [0.5, 1.5],
		// total worst-case ~30s before giving up — well past any
		// realistic kernel-mediated O_EXCL race.
		const MAX_RECLAIM_ATTEMPTS = 20;
		const BASE_BACKOFF_MS = 50;
		const BACKOFF_GROWTH = 1.5;
		let acquiredBody: LockBody | undefined;
		for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				// Equal-jitter exponential: half-fixed, half-random, so
				// every retry has at least some delay but distributes
				// peak load across the [0.5x, 1.5x] window.
				const nominal = BASE_BACKOFF_MS * BACKOFF_GROWTH ** (attempt - 1);
				const jitter = nominal * (0.5 + Math.random());
				yield* Effect.sleep(`${Math.floor(jitter)} millis`);
			}
			const body = buildOwnBody();
			const serialized = serializeBody(body);

			const exclusive = yield* fs.writeFileString(paths.lock, serialized, { flag: 'wx' }).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (exclusive) {
				acquiredBody = body;
				break;
			}

			const existing = yield* readExistingHolder();
			if (existing && isHolderLive(existing)) {
				return yield* failLocked(existing);
			}

			// Stale lock — reclaim via unlink + retry-O_EXCL. The previous
			// rename-then-readback approach was racy: A and B could both
			// rename their tmp file (each rename overwrites unconditionally)
			// and BOTH read the lock between each other's renames, then
			// both believe they won. Switching to "unlink the stale lock,
			// then loop and retry the O_EXCL writeFile from the top"
			// makes the O_EXCL the single source of truth — only one
			// writer can win the create-new-file race the kernel mediates.
			//
			// `fs.remove` is safe even if a peer reclaimer raced us to the
			// unlink: ENOENT just means someone else already cleared it,
			// which is exactly the state we wanted.
			//
			// Tempfile name still includes `${hostname}.${pid}.${uuid}` so
			// any peer reclaimer on an NFS-shared `.devstack/` whose
			// reclaim attempt is in flight can't collide on tmp paths.
			yield* fs.remove(paths.lock, { force: true }).pipe(Effect.ignore);
			// Drop a tmp probe with the hostname-tagged name to match the
			// long-lived holder's `host` field convention; we never use the
			// file's content here (the loop's next iteration will do its
			// own O_EXCL write), but creating + removing it acts as a
			// liveness check for the directory and surfaces filesystem
			// errors (ENOSPC, EROFS) before the next O_EXCL attempt.
			const probe = `${paths.lock}.tmp.${ownHost}.${process.pid}.${randomUUID()}`;
			yield* fs.writeFileString(probe, serialized).pipe(Effect.ignore);
			yield* fs.remove(probe, { force: true }).pipe(Effect.ignore);
			// Continue the loop — next iteration retries the O_EXCL write
			// against a now-clear lock path.
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
					yield* fs.remove(paths.lock, { force: true }).pipe(Effect.ignore);
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
					err instanceof StateStoreMigrationError ? Effect.fail(err) : Effect.succeed(empty),
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
			const body = JSON.stringify({ version: CURRENT_VERSION, data }, jsonBigintReplacer, 2);
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
						? fs.remove(tmp, { force: true }).pipe(Effect.ignore)
						: Effect.void,
			);
			// Best-effort — chmod is a no-op on Windows / some filesystems.
			yield* fs.chmod(paths.file, 0o600).pipe(Effect.ignore);
		});

		// Run `persist` and log any failure as a warning. Used by the
		// public `put` / `remove` ops so a failing disk doesn't crash
		// callers — but unlike the previous silent-swallow behavior we
		// at least surface the cause via the logger.
		const persistAndWarn: Effect.Effect<void> = persist.pipe(
			Effect.catchCause((cause) => Effect.logWarning('state-store: persist failed', cause)),
		);

		// `put` + `remove` carry spans so a slow disk (cross-mount NFS,
		// encrypted home dir) surfaces in tracing as an attributable hot
		// path. `get` is in-memory only — no span.
		return {
			get: <T>(key: string) =>
				Ref.get(ref).pipe(
					Effect.map((m) => (m.has(key) ? Option.some(m.get(key) as T) : Option.none<T>())),
				),
			put: <T>(key: string, value: T) =>
				Ref.update(ref, (m) => new Map(m).set(key, value))
					.pipe(Effect.andThen(persistAndWarn))
					.pipe(Effect.withSpan('StateStore.put', { attributes: { 'state.key': key } })),
			remove: (key: string) =>
				Ref.update(ref, (m) => {
					const next = new Map(m);
					next.delete(key);
					return next;
				})
					.pipe(Effect.andThen(persistAndWarn))
					.pipe(Effect.withSpan('StateStore.remove', { attributes: { 'state.key': key } })),
		};
	}),
);
