// Fork-mode orchestration helpers.
//
// Owns the runtime SDK guard for surfaces the sui-fork binary panics
// on, plus the data-dir mutual-exclusion holder protocol (acquire /
// heartbeat / release) that serializes two stacks against the same
// `<stackRoot>/sui-fork/<key>` data dir — concurrent writers to a
// single fork data dir corrupt the binary's RocksDB.

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname as nodeHostname } from 'node:os';

import { Effect, Schedule, Schema, type Scope } from 'effect';

import { atomicWriteJsonSync } from '../../substrate/runtime/atomic-write.ts';
import {
	acquireStackLock,
	isPidAlive,
	processStartTime,
} from '../../substrate/runtime/cross-process/index.ts';
import { selfPid } from '../../substrate/runtime/cross-process/self-pid.ts';
import { mintRandomSuffix } from '../../substrate/runtime/random-suffix.ts';
import { LogAttr } from '../../substrate/runtime/observability/log-attrs.ts';
import { parseVersionedDocumentBodyOrNull } from '../../substrate/versioned-doc-sync.ts';
import {
	forkUnsupportedError,
	suiPluginError,
	type ForkUnsupportedError,
	type SuiPluginError,
} from './errors.ts';

/** Lock-holder identity persisted alongside the data-dir lock file.
 *  Two fork acquires against the same data dir surface this; one
 *  wins, the other gets an actionable error. */
export interface ForkLockHolder {
	readonly pid: number;
	readonly host: string;
	readonly instanceId: string;
	readonly startedAt: number;
	/** FNV-1a hash of `ps -o lstart` for `pid`, captured at claim time
	 *  via the SAME `processStartTime` probe roster/liveness use. Lets
	 *  same-host liveness distinguish a LIVE holder from a recycled-PID
	 *  impostor (a crashed-then-reused pid). `null` when the platform
	 *  couldn't probe — treated conservatively (see `isForkHolderAlive`),
	 *  matching roster's `isOwnEntry` / `checkHolderLiveness` null policy. */
	readonly startTime: number | null;
}

// -----------------------------------------------------------------------------
// Data-dir mutual-exclusion holder protocol
// -----------------------------------------------------------------------------
//
// `acquireStackLock` is a HOLD-BRIEFLY primitive (it reclaims after
// ~30s of staleness, so it must NOT be held for the fork's lifetime —
// cross-process § "the lock is held BRIEFLY"). So the long-lived claim
// on a fork data dir is a HOLDER FILE, mirroring the roster's
// heartbeat + (pid, host) liveness pattern: we take the brief OS lock
// only to serialize the read-holder → liveness-check → write-holder
// critical section, then release it. A scope-bound fiber refreshes
// `startedAt` on a cadence comfortably under the staleness window so
// peers see we are alive; a finalizer removes the holder on teardown.

/** Heartbeat cadence — refresh `startedAt` every 10s. Matches the
 *  roster's `heartbeatIntervalMillis`. The heartbeat keeps the holder's
 *  `startedAt`/`startTime` fresh for diagnostics; it is not a reclaim
 *  gate (the pid + start-time check is), mirroring the roster heartbeat
 *  fiber. */
const FORK_HOLDER_HEARTBEAT_INTERVAL_MILLIS = 10_000;

/** Brief acquire timeout for the holder critical section. The OS lock
 *  is held only across a read → liveness-check → write, never across
 *  I/O — a tight budget keeps peers reacting quickly to a release. */
const FORK_HOLDER_LOCK_TIMEOUT_MILLIS = 5_000;

// No `version` field by design. `parseVersionedDocumentBodyOrNull`
// decodes the raw body against this schema and treats ANY decode miss
// (including a future shape change) as `null` ⇒ "no live holder",
// which the acquire path handles by reclaiming. Because the holder file
// is transient (it lives inside the data dir and a wipe removes it —
// see `forkHolderPath` below), a leftover old-shape body self-heals on
// the next acquire rather than blocking it. This mirrors stack-lock's
// precedent for short-lived holder files; persistent docs that must
// survive a format change use `versionedDocSchema` with a bumped
// version stamp instead.
const ForkLockHolderSchema = Schema.Struct({
	pid: Schema.Number,
	host: Schema.String,
	instanceId: Schema.String,
	startedAt: Schema.Number,
	startTime: Schema.NullOr(Schema.Number),
});

/** Holder file lives inside the data dir so it travels with the dir's
 *  lifecycle (wipe removes it). */
export const forkHolderPath = (dataDir: string): string => join(dataDir, 'holder.json');

/** Is an existing holder alive? Mirrors `liveness.checkHolderLiveness`
 *  (the `RosterHolder` shape doesn't fit — that carries
 *  `hostname`/`heartbeatAt`, not our `host`/`startedAt` — so we
 *  replicate its logic against the `ForkLockHolder` fields):
 *
 *  The pid must be live AND its start-time must match, so a
 *  crashed-then-recycled pid (an abandoned dir whose pid the kernel
 *  handed to an unrelated process) no longer reads as "in use".
 *
 *  A `null` start-time on either side is handled conservatively the
 *  same way roster does — ALIVE — because we have nothing to dispute
 *  the recorded identity with (mismatching a probed stamp against a
 *  recorded `null`, or vice versa, would falsely harvest a live
 *  holder). */
const isForkHolderAlive = (holder: ForkLockHolder): boolean => {
	if (!isPidAlive(holder.pid)) return false;
	const probedStart = processStartTime(holder.pid);
	if (probedStart === null) return true;
	if (holder.startTime === null) return true;
	return probedStart === holder.startTime;
};

const readForkHolder = (path: string): ForkLockHolder | null =>
	parseVersionedDocumentBodyOrNull(
		safeReadHolderRaw(path),
		ForkLockHolderSchema,
		'sui-fork.holder',
	);

/** Read the holder file's bytes, returning `''` (→ parses to null) on
 *  any I/O error. A missing/unreadable holder means "no live claim";
 *  the caller writes its own. Sync read is correct here — we are
 *  inside the brief OS-lock critical section, same non-yielding
 *  discipline as the cross-process roster reader. */
const safeReadHolderRaw = (path: string): string => {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
};

const ownForkHolder = (): ForkLockHolder => {
	const pid = selfPid();
	return {
		pid,
		host: nodeHostname(),
		instanceId: mintRandomSuffix(8),
		startedAt: Date.now(),
		// Same probe roster/liveness record at claim time — a `null`
		// (exotic platform / transient `ps` error) propagates verbatim so
		// the conservative null branch in `isForkHolderAlive` applies.
		startTime: processStartTime(pid),
	};
};

/** Run `body` under a BRIEFLY-held `stack.lock`. The lock serializes
 *  the holder file's read → liveness-check → write critical section so
 *  two claimers never both decide the dir is free. Released the moment
 *  `body` completes — never held across the fork's lifetime. */
const underStackLock = <A>(
	stackLockFile: string,
	holderPath: string,
	body: Effect.Effect<A, SuiPluginError>,
): Effect.Effect<A, SuiPluginError> =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* acquireStackLock(stackLockFile, FORK_HOLDER_LOCK_TIMEOUT_MILLIS).pipe(
				Effect.mapError((cause) =>
					suiPluginError(
						'fork-lock',
						`sui fork mode: failed to acquire stack lock for data dir ${holderPath}: ${cause._tag}`,
						cause,
					),
				),
			);
			return yield* body;
		}),
	);

/** The brief critical section: under `stack.lock`, read any existing
 *  holder; if a LIVE one is present, fail with an actionable error;
 *  otherwise claim by writing our own holder atomically. Returns the
 *  holder we wrote so the heartbeat fiber can refresh it. */
const claimForkHolder = (
	stackLockFile: string,
	holderPath: string,
): Effect.Effect<ForkLockHolder, SuiPluginError> =>
	underStackLock(
		stackLockFile,
		holderPath,
		Effect.gen(function* () {
			const existing = readForkHolder(holderPath);
			if (existing !== null && isForkHolderAlive(existing)) {
				return yield* Effect.fail(
					suiPluginError(
						'fork-lock',
						`sui fork mode: fork data dir ${holderPath} is in use by pid ${existing.pid} on ` +
							`${existing.host}; stop that stack or use a different fork key.`,
					),
				);
			}
			const self = ownForkHolder();
			yield* writeForkHolder(holderPath, self);
			return self;
		}),
	);

/** Heartbeat: under the brief lock, re-stamp `startedAt` IF the holder
 *  on disk is still ours. A peer that reclaimed us (same-host recycled-
 *  pid takeover) owns the file now; we must not clobber its claim, so a
 *  mismatched `instanceId` makes this a no-op. */
const refreshForkHolder = (
	stackLockFile: string,
	holderPath: string,
	self: ForkLockHolder,
): Effect.Effect<void, SuiPluginError> =>
	underStackLock(
		stackLockFile,
		holderPath,
		Effect.gen(function* () {
			const current = readForkHolder(holderPath);
			if (current !== null && current.instanceId !== self.instanceId) return;
			yield* writeForkHolder(holderPath, { ...self, startedAt: Date.now() });
		}),
	);

/** Scope-finalizer release: unlink the holder file ONLY if it is still
 *  ours. A finalizer that unconditionally `unlinkSync`d by path would,
 *  after a legitimate same-host reclaim (our pid crashed-and-recycled,
 *  a peer took over), delete the PEER's holder and unprotect a dir the
 *  peer is actively writing. Re-reading and matching `instanceId` makes
 *  the release a no-op once we no longer own the file. A missing/
 *  unreadable holder is already-gone — also a no-op. Best-effort: a
 *  crash that skips this is recovered by the next peer's same-host
 *  liveness check. */
const releaseOwnForkHolder = (holderPath: string, self: ForkLockHolder): void => {
	const current = readForkHolder(holderPath);
	if (current !== null && current.instanceId !== self.instanceId) return;
	try {
		unlinkSync(holderPath);
	} catch {
		// Already gone — ok.
	}
};

const writeForkHolder = (
	path: string,
	holder: ForkLockHolder,
): Effect.Effect<void, SuiPluginError> =>
	Effect.try({
		try: () => atomicWriteJsonSync(path, holder),
		catch: (cause) =>
			suiPluginError(
				'fork-lock',
				`sui fork mode: failed to write fork data-dir holder ${path}.`,
				cause,
			),
	});

/**
 * Acquire the data-dir holder for the lifetime of the surrounding
 * scope.
 *
 *   1. Briefly take `stack.lock`, read any existing holder, fail if a
 *      live peer holds it, else write our own holder. Release the OS
 *      lock immediately (the claim outlives the lock).
 *   2. Fork a scope-bound heartbeat fiber that re-takes the brief lock
 *      every `FORK_HOLDER_HEARTBEAT_INTERVAL_MILLIS` and refreshes
 *      `startedAt` (only while the file is still ours). A heartbeat
 *      failure is non-fatal — log and retry next tick (same policy as
 *      the roster heartbeat fiber).
 *   3. Register a finalizer that removes our holder file on scope
 *      close (wipe / restart / Ctrl-C) — but ONLY if the on-disk holder
 *      is still ours, so a legitimate peer reclaim is never clobbered.
 *      A crash that skips the finalizer is recovered by the next peer's
 *      liveness check (pid + start-time, see `isForkHolderAlive`).
 */
export const acquireForkDataDirHolder = (
	stackLockFile: string,
	dataDir: string,
): Effect.Effect<ForkLockHolder, SuiPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const holderPath = forkHolderPath(dataDir);
		const self = yield* claimForkHolder(stackLockFile, holderPath);
		yield* Effect.addFinalizer(() => Effect.sync(() => releaseOwnForkHolder(holderPath, self)));
		const refresh = refreshForkHolder(stackLockFile, holderPath, self).pipe(
			Effect.catch((err) =>
				Effect.logWarning('sui fork data-dir holder heartbeat failed; next tick will retry').pipe(
					Effect.annotateLogs({
						[LogAttr.phase]: err.phase,
						[LogAttr.errorMessage]: err.message,
					}),
				),
			),
		);
		yield* refresh.pipe(
			Effect.repeat(Schedule.spaced(`${FORK_HOLDER_HEARTBEAT_INTERVAL_MILLIS} millis`)),
			Effect.forkScoped,
		);
		return self;
	});

/** Surfaces that the sui-fork binary explicitly panics on. New
 *  upstream additions fail OPEN by default — architecture
 *  invariant. */
export const FORK_UNSUPPORTED_SURFACES: ReadonlyArray<string> = [
	// `client.core.*` methods that hit `simulate_transaction` /
	// balance-derivation paths the fork binary doesn't implement.
	'getBalance',
	'listBalances',
	'getCoinInfo',
] as const;

/** Wrap a Sui SDK shim with the fork guard. Property access for a
 *  blocklisted surface SYNCHRONOUSLY throws — the wire call never
 *  happens, so the fork binary stays up. */
export const wrapWithForkGuard = <Sdk extends { readonly core: object }>(sdk: Sdk): Sdk => {
	const guardedCore = new Proxy(sdk.core as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && FORK_UNSUPPORTED_SURFACES.includes(prop)) {
				const err: ForkUnsupportedError = forkUnsupportedError(
					`client.core.${prop}`,
					'fork mode does not implement this SDK surface — use the impersonation helper ' +
						'or read state via ChainProbe.',
				);
				throw err;
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as Sdk['core'];
	// Preserve all SDK fields (e.g. SuiSdkShim's opaque `client` for
	// Transaction.build) — only the `core` proxy intercepts; siblings
	// like `client` flow through unchanged.
	return { ...sdk, core: guardedCore };
};
