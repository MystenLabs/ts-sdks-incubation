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

import { Data, Effect, Schema } from 'effect';

import {
	DEFAULT_SWEEP_POLICY,
	type RosterDocument,
	RosterDocumentSchema,
	type RosterHolder,
	type RosterSweepPolicy,
} from '../../cross-process.ts';
import { atomicWriteJsonSync } from '../atomic-write.ts';
import { SpanAttr } from '../observability/spans.ts';
import { decodeJsonText } from '../runtime-decode.ts';
import { versionedDocSchema } from '../../versioned-doc-schema.ts';
import { selfPid } from './self-pid.ts';
import { acquireStackLock } from './stack-lock.ts';
import {
	isPidAlive,
	layerLivenessProbeScope,
	LivenessProbeScope,
	ownHolder,
	processStartTime,
} from './liveness.ts';

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
		const decoded = yield* decodeJsonText(RosterDocumentSchema, raw, {
			source: path,
			mkError: (issue) => new RosterCorruptError({ path, raw, cause: issue.cause ?? issue }),
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
	// Yield a fresh per-sweep liveness scope so the same pid is probed
	// AT MOST once across all holders in this pass — two holders sharing
	// a pid (corrupted-roster edge case) collapse to one fork. The
	// `Layer.provide` below scopes the cache to THIS sweep only.
	const probe = yield* LivenessProbeScope;
	const survivors: RosterHolder[] = [];
	const evicted: RosterHolder[] = [];
	const ownHost = nodeHostname();
	for (const holder of doc.holders) {
		const heartbeatStale = now - holder.heartbeatAt > policy.staleAfterMillis;
		if (!heartbeatStale) {
			survivors.push(holder);
			continue;
		}
		const liveness = yield* probe
			.probeHolderLiveness(holder, ownHost)
			.pipe(Effect.catch(() => Effect.succeed('alive' as const)));
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
}, Effect.provide(layerLivenessProbeScope));

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
	/** Sibling-file path for the container-claim ledger. Optional
	 *  because the roster's holder mutations (`claim` / `release` /
	 *  `heartbeat` / `setIntent`) never touch the ledger; only the
	 *  `addClaim` / `removeClaim` / `readClaims` / `pruneStaleClaims`
	 *  entry points require it, and they assert presence at the call
	 *  site. Sourced from `StackPathsService.containerClaimsFile` —
	 *  see `substrate/runtime/paths.ts` for the policy rationale
	 *  (closed L0 path resolver). */
	readonly containerClaimsFile?: string;
}

/** Materialize the ledger path from `RosterPaths`. Callers that
 *  invoke any of the claim-ledger APIs (`readClaims`,
 *  `pruneStaleClaims`, `addClaim`, `removeClaim`) MUST construct
 *  `RosterPaths` with `containerClaimsFile` populated from
 *  `StackPathsService.containerClaimsFile`. The previous behavior of
 *  reconstructing `dirname(rosterFile) + '/container-claims.json'`
 *  internally has been removed so nothing in the runtime tree builds
 *  cross-process paths outside the substrate path resolver. */
const requireClaimsPath = (paths: RosterPaths): string => {
	if (paths.containerClaimsFile === undefined) {
		throw new Error(
			'cross-process.roster: container-claim API called without `containerClaimsFile` ' +
				'on the RosterPaths bundle. Source this from StackPathsService.containerClaimsFile.',
		);
	}
	return paths.containerClaimsFile;
};

/** Match a roster holder against THIS process's identity.
 *
 *  Liveness elsewhere (`checkHolderLiveness`, `isContainerClaimLive`)
 *  uses `(pid, hostname, startTime)` — PID alone is insufficient on
 *  long-uptime hosts where the kernel can recycle PIDs. The roster
 *  mutators (`heartbeat`, `release`, `setIntent`) must apply the same
 *  triple match so a recycled-PID peer's entry is never silently
 *  overwritten/removed by this process.
 *
 *  `startTime` is the FNV-1a hash of `ps -o lstart` (see
 *  `liveness.processStartTime`). A `null` probe (process gone, or
 *  exotic platform) skips the start-time check — same conservative
 *  policy as `isContainerClaimLive`. */
const isOwnEntry = (
	h: RosterHolder,
	ownPid: number,
	ownHost: string,
	ownStartTime: number | null,
): boolean => {
	if (h.pid !== ownPid || h.hostname !== ownHost) return false;
	// Either side null → fall back to (pid, hostname). The roster's
	// own-entry test must symmetrically accept a null recorded stamp:
	// the writer's probe failed (exotic platform / transient `ps`
	// error) but the entry IS ours. Mismatching a probed `ownStartTime`
	// against a recorded `null` would orphan our own entry — peers
	// would then harvest it as "dead" on the next sweep.
	if (ownStartTime === null || h.startTime === null) return true;
	return h.startTime === ownStartTime;
};

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
	ownPid: number = selfPid(),
): Effect.Effect<void, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const current = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const now = Date.now();
			const ownHost = nodeHostname();
			const ownStartTime = processStartTime(ownPid);
			let touched = false;
			const next: RosterDocument = {
				version: 1,
				holders: current.holders.map((h) => {
					if (isOwnEntry(h, ownPid, ownHost, ownStartTime)) {
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
	ownPid: number = selfPid(),
): Effect.Effect<ReleaseResult, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const current = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const ownHost = nodeHostname();
			const ownStartTime = processStartTime(ownPid);
			const remaining = current.holders.filter(
				(h) => !isOwnEntry(h, ownPid, ownHost, ownStartTime),
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
	ownPid: number = selfPid(),
): Effect.Effect<void, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const current = yield* readRoster(paths.rosterFile).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_ROSTER)),
			);
			const ownHost = nodeHostname();
			const ownStartTime = processStartTime(ownPid);
			const next: RosterDocument = {
				version: 1,
				holders: current.holders.map((h) =>
					isOwnEntry(h, ownPid, ownHost, ownStartTime) ? { ...h, intent } : h,
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
						Effect.annotateLogs({
							[SpanAttr.rosterHeartbeatIntervalMs]: intervalMillis,
							[SpanAttr.errorCause]: String(err),
						}),
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
	readonly startTime?: number;
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
	startTime: Schema.optional(Schema.Number),
	hostname: Schema.String,
	claimedAt: Schema.Number,
});

const ContainerClaimDocumentSchema = versionedDocSchema(1, {
	claims: Schema.Array(ContainerClaimSchema),
});

const EMPTY_CLAIMS: ContainerClaimDocument = { version: 1, claims: [] };

const isContainerClaimLive = (
	claim: ContainerClaim,
	probeStartTime: (pid: number) => number | null,
	ownHost: string = nodeHostname(),
): boolean => {
	if (claim.hostname !== ownHost) return true;
	if (!isPidAlive(claim.pid)) return false;
	if (claim.startTime === undefined) return true;
	const probedStart = probeStartTime(claim.pid);
	if (probedStart === null) return true;
	return probedStart === claim.startTime;
};

/** Effect-flavored filter that yields a fresh `LivenessProbeScope` so
 *  the same pid is probed at most once across this pass — even when
 *  multiple claims by the same pid sit in the ledger. The scope's
 *  cache is private to this call (provided via `Effect.provide`). */
const liveContainerClaims = (
	doc: ContainerClaimDocument,
): Effect.Effect<ContainerClaimDocument> =>
	Effect.gen(function* () {
		const probe = yield* LivenessProbeScope;
		const ownHost = nodeHostname();
		const filtered: ContainerClaimDocument = {
			version: 1,
			claims: doc.claims.filter((claim) =>
				isContainerClaimLive(claim, probe.probeStartTime, ownHost),
			),
		};
		return filtered;
	}).pipe(Effect.provide(layerLivenessProbeScope));

const writeClaims = (
	path: string,
	doc: ContainerClaimDocument,
): Effect.Effect<void, RosterIoError> =>
	Effect.try({
		try: () => atomicWriteJsonSync(path, doc),
		catch: (cause) => new RosterIoError({ path, cause }),
	});

/** Read the container-claim ledger. */
export const readClaims = (
	paths: RosterPaths,
): Effect.Effect<ContainerClaimDocument, RosterError> =>
	Effect.gen(function* () {
		const path = requireClaimsPath(paths);
		if (!existsSync(path)) return EMPTY_CLAIMS;
		const raw = yield* Effect.try({
			try: () => readFileSync(path, 'utf8'),
			catch: (cause) => new RosterIoError({ path, cause }),
		});
		return yield* decodeJsonText(ContainerClaimDocumentSchema, raw, {
			source: path,
			mkError: (issue) => new RosterCorruptError({ path, raw, cause: issue.cause ?? issue }),
		});
	}).pipe(Effect.withSpan('cross-process.roster.readClaims'));

/** Prune stale same-host claims. This is the recovery path for an
 *  interrupted process that could not run its scope finalizer. */
export const pruneStaleClaims = (
	paths: RosterPaths,
): Effect.Effect<ContainerClaimDocument, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const path = requireClaimsPath(paths);
			const current = yield* readClaims(paths).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_CLAIMS)),
			);
			const next = yield* liveContainerClaims(current);
			if (next.claims.length !== current.claims.length) {
				yield* writeClaims(path, next);
			}
			return next;
		}),
	).pipe(Effect.withSpan('cross-process.roster.pruneStaleClaims'));

/** Record that this process now claims `containerKey`. No-op if
 *  already claimed by this process. */
export const addClaim = (
	paths: RosterPaths,
	containerKey: string,
): Effect.Effect<void, RosterError | import('./stack-lock.ts').StackLockError> =>
	withStackLock(
		paths,
		Effect.gen(function* () {
			const path = requireClaimsPath(paths);
			const current = yield* readClaims(paths).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_CLAIMS)),
			);
			const live = yield* liveContainerClaims(current);
			const ownPid = selfPid();
			const ownStartTime = processStartTime(ownPid) ?? undefined;
			const ownHost = nodeHostname();
			if (
				live.claims.some(
					(c) => c.containerKey === containerKey && c.pid === ownPid && c.hostname === ownHost,
				)
			) {
				if (live.claims.length !== current.claims.length) yield* writeClaims(path, live);
				return;
			}
			const next: ContainerClaimDocument = {
				version: 1,
				claims: [
					...live.claims,
					{
						containerKey,
						pid: ownPid,
						...(ownStartTime === undefined ? {} : { startTime: ownStartTime }),
						hostname: ownHost,
						claimedAt: Date.now(),
					},
				],
			};
			yield* writeClaims(path, next);
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
			const path = requireClaimsPath(paths);
			const current = yield* readClaims(paths).pipe(
				Effect.catchTag('RosterCorruptError', () => Effect.succeed(EMPTY_CLAIMS)),
			);
			const live = yield* liveContainerClaims(current);
			const ownPid = selfPid();
			const ownHost = nodeHostname();
			const remaining = live.claims.filter(
				(c) => !(c.containerKey === containerKey && c.pid === ownPid && c.hostname === ownHost),
			);
			const stillClaimedByPeer = remaining.some((c) => c.containerKey === containerKey);
			const next: ContainerClaimDocument = { version: 1, claims: remaining };
			yield* writeClaims(path, next);
			return { lastClaimReleased: !stillClaimedByPeer };
		}),
	).pipe(Effect.withSpan('cross-process.roster.removeClaim'));
