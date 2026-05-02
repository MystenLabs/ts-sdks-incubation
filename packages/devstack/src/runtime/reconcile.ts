// Reconciler. Walks an action DAG once, evaluating each action's skip
// predicate and running on miss. After the walk, dispatches Emit actions
// whose `dependsOnKind` slice intersects the dirty set produced by source
// actions (Q11). Idempotent across cycles within a single supervisor
// lifetime: stable input hashes mean a re-run is a no-op when nothing
// changed.
//
// Skip predicate logic per action:
//   - Cold cycle (no prior in memory) + `getStatus.ok === true` → skip
//     (warm-path rehydration from a manifest survives supervisor restart).
//   - Hash match + `getStatus.ok === true` → skip.
//   - Hash match + no `getStatus` → skip.
//   - Hash mismatch with prior → run unconditionally (inputs drift wins;
//     `getStatus` is NOT consulted, so a stale-but-running container
//     doesn't mask a config change).
//   - No prior + no `getStatus` + hash mismatch → run.
//   - `getStatus.ok === false` → run.
// Plus: Emit actions also run when a dirty kind they depend on changed,
// even if their own input hash matched.

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
import { stableHash } from './hash.js';
import { topoSortActions } from './topo.js';

interface ActionState {
	lastInputHash?: string;
	status: ActionStatus;
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

export class Reconciler {
	private readonly state = new Map<string, ActionState>();

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
					base.registry.consumeDirty(emit.dependsOnKind);
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
		let dirty = base.registry.flushDirty();

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
				if (status === 'healthy') triggered = true;
			}
			dirty = base.registry.flushDirty();
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

		// Network gating for Seed actions (Q5).
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
			throw new Error(
				`Verify '${action.name}' failed: ${status.detail ?? 'no detail provided'}`,
			);
		}

		// `getStatus` is consulted on the cold cycle (no `prior` — supervisor
		// restart) and on hash-match cycles, never on hash-mismatch with a
		// known prior. Otherwise an action whose inputs drifted but whose
		// container still happens to be up would silently keep the stale
		// state forever, because `getStatus` would always return ok.
		if (!forceRun) {
			if (action.getStatus !== undefined && (prior === undefined || hashMatches)) {
				const status = await action.getStatus(ctx);
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
