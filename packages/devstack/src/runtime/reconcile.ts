// Reconciler. Walks an action DAG once, evaluating each action's skip
// predicate and running on miss. After the walk, dispatches Emit actions
// whose `dependsOnKind` slice intersects the dirty set produced by source
// actions. Idempotent across cycles AND across processes: stable input
// hashes plus persisted state in the manifest mean a fresh `devstack up`
// against an existing stack skips every setup action without rerunning.
//
// Skip predicate per action type:
//
//   Service / HostProcess (liveness):
//     - Always probes `getStatus` on cold start + hash match.
//     - Hash mismatch → run unconditionally (config drift beats liveness).
//
//   Verify (invariant):
//     - Always probes `getStatus`. `ok:false` is a cycle failure, not a run.
//
//   Build / Publish / Register / Seed / Emit (setup):
//     - Hash match → skip (without probing). Plugin-level `getStatus` is
//       optional and consulted only when defined.
//     - Hash mismatch → run unconditionally.
//     - Plus: Emit also runs when a dirty kind it depends on changed,
//       even if its own input hash matched.
//
// State persistence: `Reconciler.state` is serialized into
// `Manifest.actionStates` at end-of-cycle and rehydrated at startup via
// `priorState`. Without this, every fresh process treats every action as
// a cold cycle — which is what PR 35's friction journal called the
// "rehydrate from getStatus anti-pattern."

import { seedRunsOn } from '../actions/seed.js';
import type {
	AccountsContext,
	Action,
	ActionRunContext,
	ActionStatus,
	EmitAction,
	Network,
	PortAllocator,
	Registry,
	SeedAction,
	ShutdownHook,
} from '../core/types.js';
import { getProvidesRegistryHook } from '../core/types.js';
import type { RegistryImpl } from '../registry/index.js';
import { stableHash } from './hash.js';
import { topoSortActions } from './topo.js';

interface ActionState {
	lastInputHash?: string;
	status: ActionStatus;
	lastRunAt?: number;
}

/** Persistent per-action state — the subset of `ActionState` worth
 * carrying across processes via the manifest. `status` is intentionally
 * not persisted: only `healthy` actions ever land in the state map at
 * end-of-cycle, so reproducing the in-memory shape on hydrate would be
 * lying about the post-restart state. The reconciler treats hydrated
 * entries as "this hash was last seen healthy"; the next cycle's
 * `getStatus` (if any) re-confirms liveness. */
export interface PersistedActionState {
	lastInputHash: string;
	lastRunAt?: number;
}

export interface ReconcileBaseContext {
	appName: string;
	appDir: string;
	stack: string;
	network: Network;
	registry: Registry;
	accounts: AccountsContext;
	/** Per-stack port allocator. Required on localnet (forwarded into
	 * `LocalnetActionRunContext.ports`); ignored on live nets where no
	 * local docker host bind is happening. */
	ports?: PortAllocator;
	/** Forwarded into each action's run context. Set by the supervisor. */
	onShutdown?: (fn: ShutdownHook) => void;
	/** Forwarded into each action's run context. Reconciler binds the
	 * action name so the per-action `appendLog(line)` slot just takes a
	 * line. Set by the supervisor; absent on one-shot paths. */
	appendLog?: (actionName: string, line: string) => void;
	/** Maximum number of non-Emit actions running concurrently. Default 4.
	 * Emit actions are always serialized within the topo walk + cascade
	 * because they share the registry's dirty set. Set to `1` for
	 * fully-serial behavior (useful when debugging). */
	maxConcurrency?: number;
	/**
	 * Optional interim-snapshot callback. Called once per cycle, between
	 * the topo walk and the Emit cascade, with the post-walk statuses and
	 * any Emit that's about to re-fire marked `'dirty'`. The renderer uses
	 * this to surface "cascade pending" before the cascade actually runs.
	 * The next authoritative `update()` (after the full cycle) overrides.
	 */
	progress?: (snapshot: ReconcileProgress) => void;
	/**
	 * Forward to `topoSortActions({ lenient })`. When true, drops `needs`
	 * edges that point at actions absent from the input — used by the
	 * one-shot path where an `ActionFilter` may have stripped Service or
	 * Build actions whose dependents are still in the cycle. Default false
	 * (the supervisor's full-graph cycles want strict typo detection).
	 */
	lenient?: boolean;
}

export interface ReconcileProgress {
	statuses: Map<string, ActionStatus>;
	failures: Map<string, Error>;
}

export interface ReconcileResult {
	cycles: number;
	statuses: Map<string, ActionStatus>;
	failures: Map<string, Error>;
	dirtyKinds: Set<string>;
}

export interface ReconcilerOptions {
	/** Persisted action state from a prior process — typically loaded from
	 * `Manifest.actionStates` by the supervisor / one-shot driver. Each
	 * entry is treated as "this action's `inputHash` was healthy last
	 * cycle"; the next cycle skips on hash match without rerunning
	 * `getStatus` (for actions that don't define one). */
	priorState?: Record<string, PersistedActionState>;
}

export class Reconciler {
	private readonly state = new Map<string, ActionState>();

	constructor(opts: ReconcilerOptions = {}) {
		if (opts.priorState !== undefined) {
			for (const [name, persisted] of Object.entries(opts.priorState)) {
				this.state.set(name, {
					lastInputHash: persisted.lastInputHash,
					status: 'healthy',
					lastRunAt: persisted.lastRunAt,
				});
			}
		}
	}

	async cycle(actions: Action[], base: ReconcileBaseContext): Promise<ReconcileResult> {
		const sorted = topoSortActions(actions, { lenient: base.lenient });
		const statuses = new Map<string, ActionStatus>();
		const failures = new Map<string, Error>();
		const isBlocked = (name: string): boolean => {
			const s = statuses.get(name);
			return s === 'failed' || s === 'queued';
		};
		const emitProgress = (): void => {
			base.progress?.({ statuses: new Map(statuses), failures });
		};

		// Initial snapshot: every action `queued` (waiting in topo). Without
		// this, the renderer sits on its `idle`-everything start-state until
		// the first action finishes — which can be many minutes for a cold
		// walrus.build (~10 min image build). The user thinks nothing is
		// happening. Cheap to flip.
		for (const action of sorted) statuses.set(action.name, 'queued');
		emitProgress();

		// Worker pool. Schedules independent actions in parallel up to
		// `maxConcurrency` (default 4) — walrus's 4 nodes share `needs:
		// ['walrus.deploy']`, so they become a single parallel level
		// instead of a 4-step serial walk. Emit actions stay serialized
		// because they share the registry's dirty set.
		const maxConcurrency = base.maxConcurrency ?? 4;
		const inflight = new Set<string>();
		const settled = new Set<string>();
		// Failure isolation: an action whose deps failed gets `queued` (as
		// the initial state already records). Track it explicitly so
		// downstream actions also see the block.
		const blocked = new Set<string>();

		// Precompute, for each Emit, the set of actions that transitively
		// depend on it via `needs:`. Used by the Emit serialization rule:
		// an Emit only waits for non-Emits that DON'T depend on it.
		// Without this, a Service like `vite.dev-server` that needs
		// `codegen.generate` deadlocks the scheduler — codegen waits for
		// vite to settle, vite waits for codegen to finish.
		const dependentsByName = computeDependents(sorted);

		const isReadyToRun = (a: Action): boolean => {
			if (statuses.get(a.name) !== 'queued') return false;
			if (blocked.has(a.name)) return false;
			if (a.needs !== undefined) {
				for (const need of a.needs) {
					if (blocked.has(need)) {
						blocked.add(a.name);
						return false;
					}
					const s = statuses.get(need);
					if (s === 'failed') {
						blocked.add(a.name);
						return false;
					}
					if (s !== 'healthy' && s !== 'skipped') return false;
				}
			}
			// Emit serialization: an Emit waits for every non-Emit action
			// that doesn't transitively depend on it. Concurrent non-Emit +
			// Emit would let a non-Emit dirty a kind AFTER the Emit consumed
			// it, silently breaking the dirty-cascade invariant ("Emit re-
			// fires only on truly-stale kinds"). Non-Emits that DO depend
			// on this Emit (e.g. vite.dev-server needs codegen.generate)
			// run after by virtue of `needs:` and can't race.
			if (a.type === 'Emit') {
				const dependents = dependentsByName.get(a.name) ?? new Set();
				for (const other of sorted) {
					if (other === a) continue;
					if (other.type === 'Emit') continue;
					if (dependents.has(other.name)) continue;
					if (!settled.has(other.name) && !blocked.has(other.name)) return false;
				}
				// Plus only one Emit at a time — they share the dirty set.
				for (const name of inflight) {
					const other = sorted.find((x) => x.name === name);
					if (other?.type === 'Emit') return false;
				}
			}
			// Same-signer serialization: at most one inflight action per
			// distinct `runsAs` value. Two Publish/Seed actions that
			// default to `publisher` would otherwise sign concurrent txs
			// touching the same gas object — Sui's validator-equivocation
			// guard rejects the second one. Actions without `runsAs` are
			// unconstrained.
			if (a.runsAs !== undefined) {
				for (const name of inflight) {
					const other = sorted.find((x) => x.name === name);
					if (other?.runsAs === a.runsAs) return false;
				}
			}
			return true;
		};

		const runOne = async (action: Action): Promise<void> => {
			statuses.set(action.name, 'running');
			emitProgress();
			let status: ActionStatus;
			try {
				status = await this.evaluateAndRun(action, base, false);
			} catch (err) {
				status = 'failed';
				failures.set(action.name, err instanceof Error ? err : new Error(String(err)));
			}
			statuses.set(action.name, status);
			settled.add(action.name);
			inflight.delete(action.name);
			if (status !== 'failed' && action.type === 'Emit') {
				const emit = action as EmitAction;
				if (emit.dependsOnKind !== undefined && emit.dependsOnKind.length > 0) {
					(base.registry as RegistryImpl).consumeDirty(emit.dependsOnKind);
				}
			}
			emitProgress();
		};

		// Scheduler: pick ready actions, kick them off, await any to
		// settle, repeat until nothing remains.
		const pendingPromises = new Map<string, Promise<void>>();
		while (true) {
			let scheduled = 0;
			while (inflight.size < maxConcurrency) {
				const next = sorted.find(isReadyToRun);
				if (next === undefined) break;
				inflight.add(next.name);
				pendingPromises.set(
					next.name,
					runOne(next).finally(() => pendingPromises.delete(next.name)),
				);
				scheduled++;
			}
			if (inflight.size === 0) {
				// Nothing in flight AND nothing schedulable → done. Any
				// actions still `queued` are transitively blocked; their
				// status stays `queued` per the existing failure-isolation
				// semantic (rendered same as the initial snapshot).
				if (scheduled === 0) break;
				continue;
			}
			// Wait for at least one to settle, then re-check schedulability.
			await Promise.race(pendingPromises.values());
		}

		// Dirty-tracked Emit cascade. After the topo walk, the dirty set
		// contains only kinds dirtied AFTER an Emit consumed them — i.e.
		// genuinely-stale Emits. Repeat until quiescent (an Emit could
		// mutate a kind that triggers another Emit — e.g. codegen → register
		// a `generated` kind). Bounded to prevent infinite loops on bad plugins.
		let dirty = (base.registry as RegistryImpl).flushDirty();

		// Interim snapshot: before the cascade runs, mark any Emit that's
		// about to re-fire as `'dirty'` for the renderer. Transient — the
		// final `update()` after the cascade overrides. Cheap to skip when
		// no progress callback is wired.
		if (base.progress !== undefined) {
			const interim = new Map(statuses);
			for (const action of sorted) {
				if (action.type !== 'Emit') continue;
				if (isBlocked(action.name)) continue;
				if (action.needs?.some(isBlocked)) continue;
				if (emitIsDirty(action as EmitAction, dirty)) {
					interim.set(action.name, 'dirty');
				}
			}
			base.progress({ statuses: interim, failures });
		}

		const maxCascade = 4;
		for (let round = 0; round < maxCascade && dirty.size > 0; round++) {
			let triggered = false;
			for (const action of sorted) {
				if (action.type !== 'Emit') continue;
				if (isBlocked(action.name)) continue;
				if (action.needs?.some(isBlocked)) continue;
				const emit = action as EmitAction;
				if (!emitIsDirty(emit, dirty)) continue;
				statuses.set(action.name, 'running');
				emitProgress();
				let status: ActionStatus;
				try {
					status = await this.evaluateAndRun(action, base, true);
				} catch (err) {
					status = 'failed';
					failures.set(action.name, err instanceof Error ? err : new Error(String(err)));
				}
				statuses.set(action.name, status);
				emitProgress();
				if (status === 'healthy') {
					triggered = true;
					// Match the topo-walk path (line ~196): consume the kinds the
					// Emit just observed so they don't re-trigger the same Emit
					// next cascade round. Without this, a successful cascade Emit
					// re-fires every round until `maxCascade` swallows it — only
					// invisible because the loop bound caps the runaway.
					if (emit.dependsOnKind !== undefined && emit.dependsOnKind.length > 0) {
						(base.registry as RegistryImpl).consumeDirty(emit.dependsOnKind);
					}
				}
			}
			dirty = (base.registry as RegistryImpl).flushDirty();
			if (!triggered) break;
		}

		return { cycles: 1, statuses, failures, dirtyKinds: dirty };
	}

	private async evaluateAndRun(
		action: Action,
		base: ReconcileBaseContext,
		forceRun: boolean,
	): Promise<ActionStatus> {
		const common = {
			appName: base.appName,
			appDir: base.appDir,
			registry: base.registry,
			accounts: base.accounts,
			onShutdown: base.onShutdown,
			appendLog: base.appendLog ? (line: string) => base.appendLog?.(action.name, line) : undefined,
		};
		const ctx: ActionRunContext =
			base.network === 'localnet'
				? {
						...common,
						network: 'localnet',
						stack: base.stack,
						// Ports allocator is required on localnet; supervisor +
						// runOneShot both inject it. Throw a typed error if a
						// caller forgot to pass one rather than NaN'ing through.
						ports: requirePorts(base.ports),
					}
				: { ...common, network: base.network };

		// Seed actions are localnet-only by default; authors opt into
		// live networks via `runsOn: ['testnet', 'mainnet']` (see seed.ts).
		if (action.type === 'Seed') {
			if (!seedRunsOn(action as SeedAction, base.network)) {
				return 'skipped';
			}
		}

		const inputHash = stableHash(action.inputs ?? null);
		const prior = this.state.get(action.name);
		const hashMatches = prior !== undefined && prior.lastInputHash === inputHash;

		// Verify actions: read-only invariant check. `getStatus.ok=false` is a
		// hard failure for the cycle; ok=true is healthy. No `run` ever runs.
		if (action.type === 'Verify') {
			if (action.getStatus === undefined) {
				throw new Error(
					`Verify action '${action.name}' has no getStatus — that's the only thing it does`,
				);
			}
			const status = await action.getStatus(ctx);
			if (status.ok) {
				await applyProvidesRegistry(action, ctx);
				this.state.set(action.name, {
					lastInputHash: inputHash,
					status: 'healthy',
					lastRunAt: Date.now(),
				});
				return 'healthy';
			}
			this.state.set(action.name, { lastInputHash: inputHash, status: 'failed' });
			throw new Error(`Verify '${action.name}' failed: ${status.detail ?? 'no detail provided'}`);
		}

		// `getStatus` is consulted on the cold cycle (no `prior` — supervisor
		// restart with no persisted state) and on hash-match cycles, never on
		// hash-mismatch with a known prior. Otherwise an action whose inputs
		// drifted but whose container still happens to be up would silently
		// keep the stale state forever, because `getStatus` would always
		// return ok.
		//
		// The contract is "read-only probe returning {ok, detail}". A throw
		// from the probe is ambiguous — could be a transient network blip
		// or genuine misconfiguration. Treat it as `{ok: false}` so `run`
		// gets a chance to recover, rather than permanently failing the
		// action and blocking every dependent.
		if (!forceRun) {
			if (action.getStatus !== undefined && (prior === undefined || hashMatches)) {
				let status: { ok: boolean; detail?: string };
				try {
					status = await action.getStatus(ctx);
				} catch (err) {
					if (base.appendLog !== undefined) {
						base.appendLog(
							action.name,
							`getStatus threw — treating as not-ready: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					status = { ok: false, detail: 'getStatus threw' };
				}
				if (status.ok) {
					await applyProvidesRegistry(action, ctx);
					this.state.set(action.name, {
						lastInputHash: inputHash,
						status: 'healthy',
						lastRunAt: prior?.lastRunAt,
					});
					return 'healthy';
				}
			} else if (hashMatches && action.getStatus === undefined) {
				await applyProvidesRegistry(action, ctx);
				this.state.set(action.name, { ...prior, status: 'healthy' });
				return 'healthy';
			}
		}

		if (action.run === undefined) {
			await applyProvidesRegistry(action, ctx);
			this.state.set(action.name, { lastInputHash: inputHash, status: 'healthy' });
			return 'healthy';
		}

		try {
			await action.run(ctx);
			// Apply provides.registry after run too — lets plugins factor
			// their registration into a single function used by both run
			// and warm-path skip, instead of duplicating it.
			await applyProvidesRegistry(action, ctx);
			this.state.set(action.name, {
				lastInputHash: inputHash,
				status: 'healthy',
				lastRunAt: Date.now(),
			});
			return 'healthy';
		} catch (err) {
			this.state.set(action.name, { lastInputHash: prior?.lastInputHash, status: 'failed' });
			throw err;
		}
	}

	getState(name: string): ActionState | undefined {
		return this.state.get(name);
	}

	resetAction(name: string): void {
		this.state.delete(name);
	}

	/** Snapshot the persistent slice of state for serialization into the
	 * manifest. Only actions that have a recorded `lastInputHash` are
	 * included — actions that never ran (or whose only successful state
	 * was a Verify, which doesn't have a meaningful "last input hash")
	 * are omitted. */
	serializeState(): Record<string, PersistedActionState> {
		const out: Record<string, PersistedActionState> = {};
		for (const [name, entry] of this.state) {
			if (entry.status !== 'healthy') continue;
			if (entry.lastInputHash === undefined) continue;
			out[name] = {
				lastInputHash: entry.lastInputHash,
				...(entry.lastRunAt === undefined ? {} : { lastRunAt: entry.lastRunAt }),
			};
		}
		return out;
	}
}

function emitIsDirty(emit: EmitAction, dirty: Set<string>): boolean {
	const deps = emit.dependsOnKind;
	if (deps === undefined || deps.length === 0) return false;
	return deps.some((d) => dirty.has(d));
}

/**
 * Run the action's `provides.registry` hook (if any). Called by the
 * reconciler after run AND on warm-path skips so plugins can factor their
 * registry-population logic into one place. The hook is idempotent —
 * RegistryQuery.register overwrites by name, so calling it twice in a
 * cycle is safe.
 *
 * Don't try to suppress dirty tracking here. If the rehydrate writes the
 * same data the run already wrote, the dirty set has the kind in it
 * either way; downstream Emits re-fire harmlessly. Suppression would add
 * complexity for a marginal saving.
 */
function requirePorts(ports: PortAllocator | undefined): PortAllocator {
	if (ports === undefined) {
		throw new Error(
			'reconcile: localnet cycle is missing the port allocator. ' +
				'Supervisor and runOneShot must construct one with ' +
				'`createPortAllocator({ appDir, stack })` and pass it via ' +
				'ReconcileBaseContext.ports.',
		);
	}
	return ports;
}

async function applyProvidesRegistry(action: Action, ctx: ActionRunContext): Promise<void> {
	const hook = getProvidesRegistryHook(action.provides);
	if (hook === undefined) return;
	await hook(ctx);
}

/** For each action, the set of action names that transitively depend on
 * it via `needs:`. Used by the Emit serialization rule so an Emit
 * doesn't wait on actions that need it (and would deadlock). */
function computeDependents(sorted: Action[]): Map<string, Set<string>> {
	const directDependents = new Map<string, Set<string>>();
	for (const a of sorted) directDependents.set(a.name, new Set());
	for (const a of sorted) {
		if (a.needs === undefined) continue;
		for (const need of a.needs) {
			directDependents.get(need)?.add(a.name);
		}
	}
	const transitiveDependents = new Map<string, Set<string>>();
	for (const a of sorted) {
		const seen = new Set<string>();
		const queue = [a.name];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const dep of directDependents.get(cur) ?? []) {
				if (seen.has(dep)) continue;
				seen.add(dep);
				queue.push(dep);
			}
		}
		transitiveDependents.set(a.name, seen);
	}
	return transitiveDependents;
}
