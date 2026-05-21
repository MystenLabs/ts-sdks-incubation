// `roster.json` — authoritative cross-process holder record.
//
// Architecture § Cross-process safety protocol § Roster:
//   "the authoritative cross-process record of which OS processes are
//    currently 'in' this stack."
//
// Mutated only under `stack.lock`. Schema-validated on every read so a
// truncated/forward-version write never corrupts a peer's view. Stale
// entries reaped during step-3 sweep on the next claim.

import { existsSync, readFileSync } from 'node:fs';
import { hostname as nodeHostname } from 'node:os';
import { dirname } from 'node:path';

import { Data, Effect, Schema } from 'effect';

import {
	DEFAULT_SWEEP_POLICY,
	type RosterDocument,
	RosterDocumentSchema,
	type RosterHolder,
	type RosterSweepPolicy,
} from '../../cross-process.ts';
import { atomicWriteJsonSync } from '../atomic-write.ts';
import { acquireStackLock } from './stack-lock.ts';
import { checkHolderLiveness, ownHolder } from './liveness.ts';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class RosterCorruptError extends Data.TaggedError('RosterCorruptError')<{
	readonly path: string;
	readonly raw: string;
	readonly cause: unknown;
}> {}

export class RosterIoError extends Data.TaggedError('RosterIoError')<{
	readonly path: string;
	readonly cause: unknown;
}> {}

export type RosterError = RosterCorruptError | RosterIoError;

// -----------------------------------------------------------------------------
// Read / write
// -----------------------------------------------------------------------------

const EMPTY_ROSTER: RosterDocument = { version: 1, holders: [] };

/** Read the roster from disk. Returns the empty document if absent.
 *  Tolerates a missing file but NOT a malformed file (a malformed
 *  roster surfaces a typed error so callers can decide whether to
 *  abandon or rewrite). */
export const readRoster = (path: string): Effect.Effect<RosterDocument, RosterError> =>
	Effect.gen(function* () {
		if (!existsSync(path)) return EMPTY_ROSTER;
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => new RosterIoError({ path, cause }),
		});
		const parsed = yield* Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => new RosterCorruptError({ path, raw, cause }),
		});
		const decoded = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(RosterDocumentSchema)(parsed),
			catch: (cause) => new RosterCorruptError({ path, raw, cause }),
		});
		return decoded;
	}).pipe(Effect.withSpan('cross-process.roster.read'));

/** Atomic write: route through the canonical sync primitive. The
 *  roster's mutations are all under `stack.lock`, so the non-yielding
 *  sync surface is correct here — and it shares ONE owner of the
 *  tempfile dance with state-store, cache, and manifest. */
const atomicWriteRoster = (path: string, doc: RosterDocument): Effect.Effect<void, RosterIoError> =>
	Effect.try({
		try: () => atomicWriteJsonSync(path, doc),
		catch: (cause) => new RosterIoError({ path, cause }),
	});

// -----------------------------------------------------------------------------
// Sweep
// -----------------------------------------------------------------------------

/** Walk the roster's holders and drop those that fail the liveness
 *  test AND whose heartbeats are older than `staleAfterMillis`.
 *
 *  Architecture § Claim protocol step 3 — "Holders whose
 *  `heartbeatAt` is older than 3× the heartbeat interval AND who fail
 *  the PID liveness check are evicted."
 *
 *  A live holder with a stale heartbeat is NOT evicted — heartbeat
 *  staleness alone is allowed (slow peer). The conjunction matters. */
export const sweepStaleHolders = Effect.fn('cross-process.roster.sweep')(function* (
	doc: RosterDocument,
	policy: RosterSweepPolicy = DEFAULT_SWEEP_POLICY,
	now: number = Date.now(),
) {
	const survivors: RosterHolder[] = [];
	const evicted: RosterHolder[] = [];
	for (const holder of doc.holders) {
		const heartbeatStale = now - holder.heartbeatAt > policy.staleAfterMillis;
		if (!heartbeatStale) {
			survivors.push(holder);
			continue;
		}
		const liveness = yield* checkHolderLiveness(holder).pipe(
			Effect.catch(() => Effect.succeed('alive' as const)),
		);
		if (liveness === 'dead') {
			evicted.push(holder);
		} else {
			survivors.push(holder);
		}
	}
	return {
		swept: { version: doc.version, holders: survivors } satisfies RosterDocument,
		evicted: evicted as ReadonlyArray<RosterHolder>,
	};
});

// -----------------------------------------------------------------------------
// Claim / release / heartbeat
// -----------------------------------------------------------------------------

/** Outcome of a claim: the holder this process registered, the swept
 *  document, and whether this process is now the sole holder. */
export interface ClaimResult {
	readonly self: RosterHolder;
	readonly roster: RosterDocument;
	readonly evicted: ReadonlyArray<RosterHolder>;
	readonly soleHolder: boolean;
}

/** Outcome of a release: the swept document and whether this process
 *  was the last leaver (no peers remain after removal). Architecture §
 *  Release protocol step 4. */
export interface ReleaseResult {
	readonly roster: RosterDocument;
	readonly lastLeaver: boolean;
}

interface RosterPaths {
	readonly stackLockFile: string;
	readonly rosterFile: string;
}

const withStackLock = <A, E, R>(
	paths: RosterPaths,
	body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | import('./stack-lock.ts').StackLockError, R> =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* acquireStackLock(paths.stackLockFile);
			return yield* body;
		}),
	);

/**
 * Claim protocol — architecture § Claim protocol.
 *
 * Under the exclusive lock:
 *  1. Read the roster (or initialize empty if missing).
 *  2. Sweep stale holders (PID liveness + heartbeat age).
 *  3. Append this process's entry.
 *  4. Atomic write the result.
 *
 * Returns the swept document, our holder entry, and any evicted peers.
 */
export const claim = (
	paths: RosterPaths,
	intent: 'normal' | 'snapshot' = 'normal',
	policy: RosterSweepPolicy = DEFAULT_SWEEP_POLICY,
): Effect.Effect<ClaimResult, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				'devstack.roster.path': paths.rosterFile,
				'devstack.roster.intent': intent,
			});
			const initial = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const { swept, evicted } = yield* sweepStaleHolders(initial, policy);
			const self: RosterHolder = { ...ownHolder(intent) };
			const next: RosterDocument = {
				version: 1,
				holders: [...swept.holders, self],
			};
			yield* atomicWriteRoster(paths.rosterFile, next);
			return {
				self,
				roster: next,
				evicted,
				soleHolder: swept.holders.length === 0,
			};
		}),
	).pipe(Effect.withSpan('cross-process.roster.claim'));

/**
 * Heartbeat protocol — refresh this process's `heartbeatAt`. Under the
 * stack lock to keep mutation atomic. Architecture § Heartbeat
 * protocol.
 */
export const heartbeat = (
	paths: RosterPaths,
	ownPid: number = process.pid,
): Effect.Effect<void, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const current = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const now = Date.now();
			const ownHost = nodeHostname();
			let touched = false;
			const next: RosterDocument = {
				version: 1,
				holders: current.holders.map((h) => {
					if (h.pid === ownPid && h.hostname === ownHost) {
						touched = true;
						return { ...h, heartbeatAt: now };
					}
					return h;
				}),
			};
			if (touched) yield* atomicWriteRoster(paths.rosterFile, next);
		}),
	).pipe(Effect.withSpan('cross-process.roster.heartbeat'));

/**
 * Release protocol — architecture § Release protocol.
 *
 * Removes this process's holder. Returns whether this was the
 * last-leaver (caller runs the stop finalizer if so).
 */
export const release = (
	paths: RosterPaths,
	ownPid: number = process.pid,
): Effect.Effect<ReleaseResult, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const current = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const ownHost = nodeHostname();
			const remaining = current.holders.filter(
				(h) => !(h.pid === ownPid && h.hostname === ownHost),
			);
			const next: RosterDocument = { version: 1, holders: remaining };
			yield* atomicWriteRoster(paths.rosterFile, next);
			return {
				roster: next,
				lastLeaver: remaining.length === 0,
			};
		}),
	).pipe(Effect.withSpan('cross-process.roster.release'));

/**
 * Set this process's `intent` (`normal` ↔ `snapshot`) under the
 * exclusive lock. Architecture § Concurrent snapshot step 2 / 5.
 */
export const setIntent = (
	paths: RosterPaths,
	intent: 'normal' | 'snapshot',
	ownPid: number = process.pid,
): Effect.Effect<void, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const current = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const ownHost = nodeHostname();
			const next: RosterDocument = {
				version: 1,
				holders: current.holders.map((h) =>
					h.pid === ownPid && h.hostname === ownHost ? { ...h, intent } : h,
				),
			};
			yield* atomicWriteRoster(paths.rosterFile, next);
		}),
	).pipe(Effect.withSpan('cross-process.roster.setIntent'));

/** Background heartbeat fiber. Wakes every `intervalMillis` (default
 *  matches `DEFAULT_SWEEP_POLICY.heartbeatIntervalMillis`) and refreshes
 *  this process's `heartbeatAt`.
 *
 *  Returns an Effect that runs forever in its Scope — the supervisor
 *  forks it via `Effect.forkScoped` so it tears down with the stack. */
export const heartbeatFiber = (
	paths: RosterPaths,
	intervalMillis: number = DEFAULT_SWEEP_POLICY.heartbeatIntervalMillis,
): Effect.Effect<never> =>
	Effect.gen(function* () {
		while (true) {
			yield* Effect.sleep(`${intervalMillis} millis`);
			yield* heartbeat(paths).pipe(
				// A heartbeat failure is non-fatal — the next peer's sweep
				// would otherwise evict us, but the architecture treats this
				// as "the dev didn't get to flush a heartbeat in time;
				// recover by retrying next interval." Log via Effect's
				// logger; do not propagate.
				Effect.catch((err) =>
					Effect.logWarning('roster heartbeat failed').pipe(
						Effect.annotateLogs({ 'roster.heartbeat.error': String(err) }),
					),
				),
			);
		}
	}).pipe(Effect.withSpan('cross-process.roster.heartbeatFiber'));

// -----------------------------------------------------------------------------
// Container-claim ledger
// -----------------------------------------------------------------------------
//
// Architecture § Cross-process safety protocol: roster "Records claimed
// containers per process. Last-leaver semantics: when a process
// releases its last claim and confirms no other process holds the
// container, it may tear down."
//
// The roster document carries holders only — the per-container claim
// ledger lives in an EXTENSION file at `<stackRoot>/container-claims.json`
// so the architecture-mandated `RosterDocument` shape doesn't widen.
// Same atomicity discipline: mutate under `stack.lock`.

export interface ContainerClaim {
	readonly containerKey: string;
	readonly pid: number;
	readonly hostname: string;
	readonly claimedAt: number;
}

export interface ContainerClaimDocument {
	readonly version: 1;
	readonly claims: ReadonlyArray<ContainerClaim>;
}

const ContainerClaimSchema = Schema.Struct({
	containerKey: Schema.String,
	pid: Schema.Number,
	hostname: Schema.String,
	claimedAt: Schema.Number,
});

const ContainerClaimDocumentSchema = Schema.Struct({
	version: Schema.Literal(1),
	claims: Schema.Array(ContainerClaimSchema),
});

const EMPTY_CLAIMS: ContainerClaimDocument = { version: 1, claims: [] };

const claimsPath = (rosterFile: string): string => `${dirname(rosterFile)}/container-claims.json`;

/** Read the container-claim ledger. */
export const readClaims = (
	paths: RosterPaths,
): Effect.Effect<ContainerClaimDocument, RosterError> =>
	Effect.gen(function* () {
		const path = claimsPath(paths.rosterFile);
		if (!existsSync(path)) return EMPTY_CLAIMS;
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => new RosterIoError({ path, cause }),
		});
		const parsed = yield* Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => new RosterCorruptError({ path, raw, cause }),
		});
		return yield* Effect.try({
			try: () => Schema.decodeUnknownSync(ContainerClaimDocumentSchema)(parsed),
			catch: (cause) => new RosterCorruptError({ path, raw, cause }),
		});
	}).pipe(Effect.withSpan('cross-process.roster.readClaims'));

/** Record that this process now claims `containerKey`. No-op if
 *  already claimed by this process. */
export const addClaim = (
	paths: RosterPaths,
	containerKey: string,
): Effect.Effect<void, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const path = claimsPath(paths.rosterFile);
			const current = yield* readClaims(paths).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_CLAIMS)),
			);
			const ownPid = process.pid;
			const ownHost = nodeHostname();
			if (
				current.claims.some(
					(c) => c.containerKey === containerKey && c.pid === ownPid && c.hostname === ownHost,
				)
			) {
				return;
			}
			const next: ContainerClaimDocument = {
				version: 1,
				claims: [
					...current.claims,
					{ containerKey, pid: ownPid, hostname: ownHost, claimedAt: Date.now() },
				],
			};
			yield* Effect.try({
				try: () => atomicWriteJsonSync(path, next),
				catch: (cause) => new RosterIoError({ path, cause }),
			});
		}),
	).pipe(Effect.withSpan('cross-process.roster.addClaim'));

/** Release this process's claim on `containerKey`. Returns whether
 *  the container has zero remaining claims AFTER this release — the
 *  "last-leaver" signal that authorizes a teardown.
 *
 *  Architecture § Cross-process safety protocol: "when a process
 *  releases its last claim and confirms no other process holds the
 *  container, it may tear down." */
export const removeClaim = (
	paths: RosterPaths,
	containerKey: string,
): Effect.Effect<
	{ readonly lastClaimReleased: boolean },
	RosterError | import('./stack-lock.ts').StackLockError
> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const path = claimsPath(paths.rosterFile);
			const current = yield* readClaims(paths).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_CLAIMS)),
			);
			const ownPid = process.pid;
			const ownHost = nodeHostname();
			const remaining = current.claims.filter(
				(c) => !(c.containerKey === containerKey && c.pid === ownPid && c.hostname === ownHost),
			);
			const stillClaimedByPeer = remaining.some((c) => c.containerKey === containerKey);
			const next: ContainerClaimDocument = { version: 1, claims: remaining };
			yield* Effect.try({
				try: () => atomicWriteJsonSync(path, next),
				catch: (cause) => new RosterIoError({ path, cause }),
			});
			return { lastClaimReleased: !stillClaimedByPeer };
		}),
	).pipe(Effect.withSpan('cross-process.roster.removeClaim'));
