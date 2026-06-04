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

import { Context, Effect, Layer } from 'effect';

import type { RosterHolder } from '../../cross-process.ts';
import { selfPid } from './self-pid.ts';

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
	// lifetime — cache the first SUCCESSFUL probe forever. Eliminates
	// the `ps` spawn under high in-process contention (e.g. N fibers
	// fighting over a single cross-process lock all probing each
	// other's shared pid). Without this cache, 8 concurrent fibers
	// each fork `ps -o lstart` with a 2s timeout, compounding into
	// seconds of latency that exhaust the claim budget (review fix
	// phase 22f reclaim-stress reproducer caught it).
	//
	// Only a non-null result is memoized: a `null` here means the
	// probe transiently FAILED (spawn hiccup / 2s timeout under load),
	// not that the pid is gone — it's our own pid, which is alive by
	// definition. Caching that null forever would surrender this
	// process's PID-reuse protection (it would write `startTime: null`
	// to disk for its whole lifetime) on a single flaky fork. Leaving
	// the cache UNSET re-probes on the next call; an occasional extra
	// `ps` on a previously-failing probe is negligible versus losing
	// reuse protection for the lifetime.
	if (pid === selfPid()) {
		if (ownStartTimeCache !== UNSET) return ownStartTimeCache;
		const probed = probeStartTimeUncached(pid);
		if (probed !== null) ownStartTimeCache = probed;
		return probed;
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
// Only a successful (non-null) self-pid probe is ever stored here; a
// failed probe leaves this UNSET so the next call re-probes.
let ownStartTimeCache: number | typeof UNSET = UNSET;

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
 *  sweep AND the stack-lock one-shot orphan check.
 *
 *  Discipline:
 *   - Foreign-host (`hostname` differs from our own) → ALWAYS alive
 *     (NFS-safe default; cross-host pid comparisons are meaningless).
 *   - Same-host: pid must be live AND start-time must match.
 *
 *  Returns `'alive' | 'dead'`. Never throws. Effect-wrapped so callers
 *  compose under spans. */
export const checkHolderLiveness = Effect.fn('cross-process.liveness.checkHolderLiveness')(
	function* (holder: RosterHolder, ownHost: string = nodeHostname(), cache?: LivenessCache) {
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
 *  `'normal'`; the snapshot bounce flips it to `'snapshot'`
 *  under the stack lock and back when the bounce completes.
 *
 *  A `null` `startTime` propagates verbatim — readers (`isOwnEntry`
 *  in `roster.ts`, `checkHolderLiveness` above) honor the null-
 *  conservative branch. Writing `0` for "unprobable" would cause a
 *  false-dead harvest: a subsequent probe yielding a real stamp would
 *  mismatch the recorded `0` and the process would fail to recognize
 *  its own entry. */
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

// -----------------------------------------------------------------------------
// Reaper combinator — the single home for the per-sweep liveness wiring.
// -----------------------------------------------------------------------------
//
// Both the docker boot-time orphan sweep (`runtime/docker/sweep.ts`) and
// the cross-stack lifecycle-prune orchestrator (`orchestrators/
// lifecycle-prune/index.ts`) run a "reaper" pass: a single sweep over
// some inventory that decides what is reclaimable. Each pass needs a
// FRESH `LivenessProbeScope` so a recycled-PID corner case forks the OS
// liveness probe AT MOST once per pass — and the `Effect.provide(
// layerLivenessProbeScope)` + `checkHolderLiveness` wiring was being
// repeated at each call site. `makeReaper` (and the `withLivenessSweepScope`
// combinator it returns) collapses that wiring into ONE place.
//
// This is ABSTRACTION ONLY — it does not change WHEN either reaper runs,
// what it sweeps, or the order of its removals. Each caller keeps its own
// orchestration (docker/sweep stays boot-phase under stack.lock with the
// lock held only over the claim read; lifecycle-prune stays the L4 user
// command with its `(app, stack)` grouping). The combinator provides only
// the per-sweep liveness scope + the shared holder-liveness probe.

/** A reaper handle: a `scopeName` for the sweep plus the shared
 *  per-sweep liveness-scope combinator every sweep pass reuses. */
export interface Reaper {
	/** The reaper's name — used to derive the sweep span so each pass is
	 *  attributable. */
	readonly scopeName: string;
	/** Run `body` under a FRESH per-sweep `LivenessProbeScope` (a private
	 *  cache scoped to THIS pass) so the same pid is probed at most once
	 *  across the sweep. The wiring (`Effect.provide(layerLivenessProbeScope)`)
	 *  lives HERE, not at the call site — so the `LivenessProbeScope` +
	 *  `checkHolderLiveness` plumbing both reapers depend on has a single
	 *  home. Adds no span of its own: each caller keeps its existing trace
	 *  structure (no nesting change). */
	readonly withLivenessSweepScope: <A, E, R>(
		body: Effect.Effect<A, E, R | LivenessProbeScope>,
	) => Effect.Effect<A, E, Exclude<R, LivenessProbeScope>>;
}

/** Build a reaper handle for a named sweep. The single place the
 *  per-sweep `LivenessProbeScope` provisioning is assembled — both
 *  `docker/sweep.ts` and `lifecycle-prune` instantiate one rather than
 *  re-threading `layerLivenessProbeScope` themselves.
 *
 *  ABSTRACTION ONLY: `makeReaper` neither schedules nor reorders a
 *  sweep. It provides the fresh per-pass liveness cache; the caller
 *  keeps full ownership of WHAT it sweeps, WHEN, and in WHAT ORDER (and
 *  any lock discipline around the decision). */
export const makeReaper = (scopeName: string): Reaper => {
	const withLivenessSweepScope = <A, E, R>(
		body: Effect.Effect<A, E, R | LivenessProbeScope>,
	): Effect.Effect<A, E, Exclude<R, LivenessProbeScope>> =>
		body.pipe(Effect.provide(layerLivenessProbeScope));

	return { scopeName, withLivenessSweepScope };
};
