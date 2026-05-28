// PID + start-time liveness check.
//
// Architecture § Cross-process safety protocol § Claim protocol step 3:
// "process exists AND its start-time (as read from `/proc/<pid>/stat` on
// Linux, `ps -o lstart` on macOS, or equivalent) matches the recorded
// `startTime`."
//
// Foreign-host entries are treated as alive (NFS-safe conservative
// default). On the same host, two checks combine: `kill(pid, 0)`
// determines pid-in-use; `ps -o lstart` confirms it's the SAME process
// (defending against pid reuse on long-uptime machines).
//
// This module is the ONLY place in the substrate that calls into
// `process.kill` and shells out for start times. Roster/snapshot
// reservation/stack-lock all consult it through the typed predicates.

import { execFileSync } from 'node:child_process';
import { hostname as nodeHostname } from 'node:os';

import { Context, Data, Effect, Layer } from 'effect';

import type { RosterHolder } from '../../cross-process.ts';
import { selfPid } from './self-pid.ts';

/** Tagged failure when the start-time probe itself errored unexpectedly
 *  (timeout, missing utility, etc.). Distinguished from "pid absent",
 *  which is signaled by `processStartTime` returning `null`. */
export class StartTimeProbeError extends Data.TaggedError('StartTimeProbeError')<{
	readonly pid: number;
	readonly cause: unknown;
}> {}

/** Cheap "send signal 0" pid liveness. ESRCH → dead; EPERM → alive
 *  (foreign-user pid on shared dev hosts). Any other errno is
 *  conservatively treated as dead so we don't refuse cleanup on exotic
 *  platforms. */
export const isPidAlive = (pid: number): boolean => {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === 'EPERM';
	}
};

/** Per-sweep cache mapping `pid → start-time stamp` (or `null` when the
 *  pid is gone/unprobable). Callers that issue many probes in a single
 *  sweep (roster step-3 stale-eviction, container-claim ledger prune,
 *  etc.) instantiate one cache per pass and thread it through every
 *  probe call so the same pid forks `ps`/`tasklist` AT MOST once per
 *  sweep. Single-shot callers omit the cache and get the no-cache
 *  behavior.
 *
 *  Discriminator is `Map.has(pid)` — a cached `null` is a real result
 *  (the pid is missing) and skipping it would re-fork pointlessly. */
export type LivenessCache = Map<number, number | null>;

/** Best-effort start-time stamp for `pid`. Returns `null` when the
 *  process is gone OR the platform can't produce a time. The stamp
 *  itself is opaque text — its only contract is bytewise equality with
 *  a previously-recorded sibling stamp.
 *
 *  Architecture § Cross-process safety protocol §3 — `ps -o lstart` on
 *  macOS/Linux, `tasklist` confirmation on Windows.
 *
 *  Pass `cache` to reuse a previously-probed result across a sweep
 *  pass — same `pid` only forks the underlying utility once. */
export const processStartTime = (pid: number, cache?: LivenessCache): number | null => {
	if (!Number.isFinite(pid) || pid <= 0) return null;
	// Our own pid's startTime never changes during the process
	// lifetime — cache the first probe forever. Eliminates the `ps`
	// spawn under high in-process contention (e.g. N fibers fighting
	// over a single cross-process lock all probing each other's
	// shared pid). Without this cache, 8 concurrent fibers each fork
	// `ps -o lstart` with a 2s timeout, compounding into seconds of
	// latency that exhaust the claim budget (review fix phase 22f
	// reclaim-stress reproducer caught it).
	if (pid === selfPid()) {
		if (ownStartTimeCache === UNSET) {
			ownStartTimeCache = probeStartTimeUncached(pid);
		}
		return ownStartTimeCache;
	}
	if (cache?.has(pid)) {
		// Map.get is `T | undefined` — but `has` is true, so the value
		// is one of the cached results (a `number` or `null`).
		return cache.get(pid) ?? null;
	}
	const probed = probeStartTimeUncached(pid);
	cache?.set(pid, probed);
	return probed;
};

const UNSET: unique symbol = Symbol('UNSET');
let ownStartTimeCache: number | null | typeof UNSET = UNSET;

/** Inner probe — always forks the platform utility. Split out so the
 *  cache branch in `processStartTime` stays a single read/write. */
const probeStartTimeUncached = (pid: number): number | null => {
	if (process.platform === 'win32') {
		try {
			const out = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
				encoding: 'utf8',
				timeout: 2000,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			// Windows path: just hash the line. Windows PID reuse on uptime
			// is a known v1 trade-off; the architecture says the protocol
			// stays POSIX-first.
			return out.trim().startsWith('"') ? hashStartTimeStamp(out.trim()) : null;
		} catch {
			return null;
		}
	}
	try {
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			encoding: 'utf8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? hashStartTimeStamp(trimmed) : null;
	} catch {
		return null;
	}
};

/** Stable hash of a start-time string. Reduces the textual `ps -o
 *  lstart=` output to a single number so the roster carries a fixed-
 *  width integer (the architecture's `startTime` field is `number`).
 *
 *  FNV-1a 32-bit; collisions are negligible at the (pid, host, second)
 *  granularity we ever compare. */
const hashStartTimeStamp = (stamp: string): number => {
	let h = 2166136261;
	for (let i = 0; i < stamp.length; i++) {
		h ^= stamp.charCodeAt(i);
		h = (h * 16777619) >>> 0;
	}
	// Stay inside Number.MAX_SAFE_INTEGER's positive 32-bit range so the
	// number round-trips through JSON without precision loss.
	return h >>> 0;
};

/** Liveness probe for a roster holder. Used by the claim-protocol
 *  sweep AND the snapshot-reservation orphan check.
 *
 *  Discipline:
 *   - Foreign-host (`hostname` differs from our own) → ALWAYS alive
 *     (NFS-safe default; cross-host pid comparisons are meaningless).
 *   - Same-host: pid must be live AND start-time must match.
 *
 *  Returns `'alive' | 'dead'`. Never throws. Effect-wrapped so callers
 *  compose under spans. */
export const checkHolderLiveness = Effect.fn('cross-process.liveness.checkHolderLiveness')(
	function* (
		holder: RosterHolder,
		ownHost: string = nodeHostname(),
		cache?: LivenessCache,
	) {
		// Foreign-host: NFS-safe — we can't verify, assume alive.
		if (holder.hostname !== ownHost) {
			return 'alive' as const;
		}
		yield* Effect.annotateCurrentSpan({
			'devstack.holder.pid': holder.pid,
			'devstack.holder.host': holder.hostname,
		});
		if (!isPidAlive(holder.pid)) return 'dead' as const;
		const probedStart = processStartTime(holder.pid, cache);
		// pid alive but no stamp probable → conservative: ALIVE
		// (we have nothing to dispute the recorded startTime with).
		if (probedStart === null) return 'alive' as const;
		// Holder recorded a `null` startTime (writer's platform couldn't
		// probe at the time). The (pid, hostname) pair carries the
		// identity; same conservative policy as the probedStart-null
		// branch. Mismatching a real probed stamp against a recorded
		// `null` would otherwise harvest live holders as "dead".
		if (holder.startTime === null) return 'alive' as const;
		return probedStart === holder.startTime ? ('alive' as const) : ('dead' as const);
	},
);

/** Build a holder snapshot for THIS process. The intent defaults to
 *  `'normal'`; the snapshot-reservation flow flips it to `'snapshot'`
 *  under the stack lock and back when the reservation releases.
 *
 *  A `null` `startTime` propagates verbatim — readers (`isOwnEntry`
 *  in `roster.ts`, `checkHolderLiveness` above) honor the null-
 *  conservative branch. Writing `0` for "unprobable" was the prior
 *  shape and caused a false-dead harvest: a subsequent probe yielding
 *  a real stamp would mismatch the recorded `0` and the process could
 *  no longer recognize its own entry. */
export const ownHolder = (intent: 'normal' | 'snapshot' = 'normal'): RosterHolder => {
	const pid = selfPid();
	const startTime = processStartTime(pid);
	return {
		pid,
		startTime,
		hostname: nodeHostname(),
		claimedAt: Date.now(),
		heartbeatAt: Date.now(),
		intent,
	};
};

// -----------------------------------------------------------------------------
// LivenessProbeScope — per-sweep cache, lifted out of the Map parameter.
// -----------------------------------------------------------------------------
//
// The bare `LivenessCache = Map<pid, stamp | null>` was threaded through
// `roster.sweepStaleHolders` and `liveContainerClaims` as an explicit
// parameter, which is fine for two sites but doesn't scale to the three
// other sweep loops (dispatch routes, doctor probes, lifecycle-prune)
// that haven't migrated yet. Promoting the cache into a service lets a
// sweep loop `yield* LivenessProbeScope` once and call the probe
// methods without re-passing the Map. The optional-Map params on
// `processStartTime` / `checkHolderLiveness` stay so unmigrated callers
// can keep working from outside an Effect.

/** Methods a per-sweep scope exposes — the captured cache backs both
 *  so the same `pid` forks `ps`/`tasklist` at most once per scope. */
export interface LivenessProbeScopeShape {
	readonly probeStartTime: (pid: number) => number | null;
	readonly probeHolderLiveness: (
		holder: RosterHolder,
		ownHost?: string,
	) => Effect.Effect<'alive' | 'dead'>;
}

/** A per-sweep liveness scope. Callers `yield* LivenessProbeScope`
 *  once per sweep (typically inside an `Effect.scoped` block that
 *  wraps the loop) and call `probeStartTime` / `probeHolderLiveness`
 *  on each holder without threading the Map manually. */
export class LivenessProbeScope extends Context.Service<
	LivenessProbeScope,
	LivenessProbeScopeShape
>()('@devstack/substrate/cross-process/LivenessProbeScope') {}

/** Construct a fresh `LivenessProbeScope` whose underlying cache is
 *  private to this layer — every yielding scope gets its own Map. */
export const layerLivenessProbeScope: Layer.Layer<LivenessProbeScope> = Layer.effect(
	LivenessProbeScope,
	Effect.sync(() => {
		const cache: LivenessCache = new Map();
		return LivenessProbeScope.of({
			probeStartTime: (pid) => processStartTime(pid, cache),
			probeHolderLiveness: (holder, ownHost = nodeHostname()) =>
				checkHolderLiveness(holder, ownHost, cache),
		});
	}),
);
