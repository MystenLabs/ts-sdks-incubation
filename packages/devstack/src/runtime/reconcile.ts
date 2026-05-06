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
	RegistryQuery,
	SeedAction,
	ShutdownHook,
} from '../core/types.js';
import type { InternalRegistry } from '../registry/index.js';
import { stableHash } from './hash.js';
import { topoSortActions } from './topo.js';

interface ActionState {
	lastInputHash?: string;
	status: ActionStatus;
	lastRunAt?: number;
	/** Whatever the action's `identity(ctx)` returned at the end of its
	 * last successful run / skip. The reconciler folds the identities of
	 * an action's `needs:` into its input hash, so an upstream identity
	 * change cascades-re-runs every downstream automatically (chain
	 * regenesis, package republish, deploy-file rewrite, …). */
	identity?: string;
}

/** Persistent per-action state — the subset of `ActionState` worth
 * carrying across processes via the manifest. `status` is intentionally
 * not persisted: only `ok` actions ever land in the state map at
 * end-of-cycle, so reproducing the in-memory shape on hydrate would be
 * lying about the post-restart state. The reconciler treats hydrated
 * entries as "this hash was last seen ok"; the next cycle's
 * `getStatus` (if any) re-confirms liveness. */
interface PersistedActionState {
	lastInputHash: string;
	lastRunAt?: number;
	/** Last-known identity for this action; round-trips through the
	 * manifest so cold starts cascade correctly when an upstream's
	 * identity drifted while the supervisor was offline. */
	identity?: string;
}

interface ReconcileBaseContext {
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
	/** Forwarded into each action's run context after the reconciler binds
	 * the action's own name as `label`. The supervisor records the labeled
	 * hook so the renderer's shutdown panel can show "stopping
	 * frontend.dev-server" rather than "hook 3/7". Public
	 * `ctx.onShutdown(fn)` shape stays unchanged — labels are auto-derived. */
	onShutdown?: (label: string, fn: ShutdownHook) => void;
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
	/**
	 * Halts new-action scheduling once aborted. Already-inflight actions
	 * still drain (no in-action cancellation), and the Emit cascade is
	 * skipped. Set by the supervisor on SIGINT so shutdown can quiesce
	 * the cycle before firing hooks — without it, the cycle keeps
	 * spawning new containers / HostProcess children AFTER `shutdown()`
	 * has already drained the hook list, leaving the new resources
	 * orphaned.
	 */
	signal?: AbortSignal;
}

export interface ReconcileProgress {
	statuses: Map<string, ActionStatus>;
	failures: Map<string, Error>;
}

interface ReconcileResult {
	cycles: number;
	statuses: Map<string, ActionStatus>;
	failures: Map<string, Error>;
	dirtyKinds: Set<string>;
}

interface ReconcilerOptions {
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
					status: 'ok',
					lastRunAt: persisted.lastRunAt,
					identity: persisted.identity,
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
		// seal.build (~5–8 min full Rust compile) or walrus.build (~2–3 min
		// hybrid). The user thinks nothing is happening. Cheap to flip.
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
		// Without this, a Service like `frontend.dev-server` that needs
		// `codegen.generate` deadlocks the scheduler — codegen waits for
		// the dev server to settle, the dev server waits for codegen.
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
					if (s !== 'ok' && s !== 'skipped') return false;
				}
			}
			// Emit serialization: an Emit waits for every non-Emit action
			// that doesn't transitively depend on it. Concurrent non-Emit +
			// Emit would let a non-Emit dirty a kind AFTER the Emit consumed
			// it, silently breaking the dirty-cascade invariant ("Emit re-
			// fires only on truly-stale kinds"). Non-Emits that DO depend
			// on this Emit (e.g. frontend.dev-server needs codegen.generate)
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
					(base.registry as InternalRegistry).consumeDirty(emit.dependsOnKind);
				}
			}
			emitProgress();
		};

		// Scheduler: pick ready actions, kick them off, await any to
		// settle, repeat until nothing remains.
		const pendingPromises = new Map<string, Promise<void>>();
		while (true) {
			let scheduled = 0;
			// Abort drains the inflight set without scheduling more — the
			// Emit cascade below is skipped on the same condition. Already-
			// running actions don't get cancelled (no in-action signal yet),
			// so they finish naturally and register their shutdown hooks
			// before the supervisor fires them.
			if (base.signal?.aborted !== true) {
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

		if (base.signal?.aborted === true) {
			return { cycles: 1, statuses, failures, dirtyKinds: new Set() };
		}

		const dirtyKinds = await this.runEmitCascade(sorted, base, statuses, failures, isBlocked);
		return { cycles: 1, statuses, failures, dirtyKinds };
	}

	/** Dirty-tracked Emit cascade. After the topo walk, the dirty set
	 * contains only kinds dirtied AFTER an Emit consumed them — i.e.
	 * genuinely-stale Emits. Repeat until quiescent: an Emit could mutate
	 * a kind that triggers another Emit (codegen → register a generated
	 * kind). Bounded by `maxCascade` to keep a buggy plugin from looping
	 * forever. Returns the residual dirty set after the cascade settles. */
	private async runEmitCascade(
		sorted: Action[],
		base: ReconcileBaseContext,
		statuses: Map<string, ActionStatus>,
		failures: Map<string, Error>,
		isBlocked: (name: string) => boolean,
	): Promise<Set<string>> {
		const emitProgress = (): void => {
			base.progress?.({ statuses: new Map(statuses), failures });
		};
		let dirty = (base.registry as InternalRegistry).flushDirty();

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
				if (status === 'ok') {
					triggered = true;
					// Match the topo-walk path (line ~196): consume the kinds the
					// Emit just observed so they don't re-trigger the same Emit
					// next cascade round. Without this, a successful cascade Emit
					// re-fires every round until `maxCascade` swallows it — only
					// invisible because the loop bound caps the runaway.
					if (emit.dependsOnKind !== undefined && emit.dependsOnKind.length > 0) {
						(base.registry as InternalRegistry).consumeDirty(emit.dependsOnKind);
					}
				}
			}
			dirty = (base.registry as InternalRegistry).flushDirty();
			if (!triggered) break;
		}
		return dirty;
	}

	private async evaluateAndRun(
		action: Action,
		base: ReconcileBaseContext,
		forceRun: boolean,
	): Promise<ActionStatus> {
		// Seed actions are localnet-only by default; authors opt into
		// live networks via `runsOn: ['testnet', 'mainnet']` (see seed.ts).
		if (action.type === 'Seed') {
			if (!seedRunsOn(action as SeedAction, base.network)) {
				return 'skipped';
			}
		}

		const inputHash = this.computeInputHash(action);
		const ctx = this.buildActionCtx(action, base, inputHash);
		const prior = this.state.get(action.name);
		const hashMatches = prior !== undefined && prior.lastInputHash === inputHash;

		// Verify actions: read-only invariant check. `getStatus.ok=false`
		// is a hard failure for the cycle; ok=true is healthy. No `run`.
		if (action.type === 'Verify') {
			return this.evaluateVerify(action, ctx, base, prior, inputHash);
		}

		// `getStatus` is consulted on the cold cycle (no `prior` —
		// supervisor restart with no persisted state) and on hash-match
		// cycles, never on hash-mismatch with a known prior. Otherwise an
		// action whose inputs drifted but whose container still happens
		// to be up would silently keep the stale state forever, because
		// `getStatus` would always return ok.
		if (!forceRun) {
			const skipResult = await this.tryWarmPathSkip(action, ctx, base, prior, hashMatches, inputHash);
			if (skipResult !== undefined) return skipResult;
		}

		return this.runAction(action, ctx, base, prior, inputHash);
	}

	/** Fold upstream identities into the input hash so a needs-edge
	 * becomes a real cascade signal: when an upstream's `identity`
	 * changes (chain regenesis, package republish, deploy file rewrite),
	 * every downstream's hash mismatches and re-runs without any
	 * per-action chain probe. Sorted-by-name so the hash is stable across
	 * `needs:` re-orderings. */
	private computeInputHash(action: Action): string {
		const upstreamIdentities: Record<string, string> = {};
		if (action.needs !== undefined) {
			for (const need of action.needs) {
				const id = this.state.get(need)?.identity;
				if (id !== undefined) upstreamIdentities[need] = id;
			}
		}
		return stableHash({
			inputs: action.inputs ?? null,
			upstream:
				Object.keys(upstreamIdentities).length === 0 ? null : upstreamIdentities,
		});
	}

	/** Build the per-action `ActionRunContext` that gets passed to
	 * `run` / `getStatus` / `identity`. Localnet adds `stack` + `ports`;
	 * live nets carry only the common fields. The wrapping registry
	 * Proxy stamps `providedBy: actionName` onto every register call. */
	private buildActionCtx(
		action: Action,
		base: ReconcileBaseContext,
		inputHash: string,
	): ActionRunContext {
		const common = {
			appName: base.appName,
			appDir: base.appDir,
			registry: wrapRegistryForAction(base.registry, action.name),
			accounts: base.accounts,
			onShutdown: base.onShutdown
				? (fn: ShutdownHook) => base.onShutdown!(action.name, fn)
				: undefined,
			appendLog: base.appendLog ? (line: string) => base.appendLog?.(action.name, line) : undefined,
			inputHash,
		};
		if (base.network === 'localnet') {
			return {
				...common,
				network: 'localnet',
				stack: base.stack,
				// Ports allocator is required on localnet; supervisor +
				// runOneShot both inject it. Throw a typed error if a
				// caller forgot to pass one rather than NaN'ing through.
				ports: requirePorts(base.ports),
			};
		}
		return { ...common, network: base.network };
	}

	private async evaluateVerify(
		action: Action,
		ctx: ActionRunContext,
		base: ReconcileBaseContext,
		prior: ActionState | undefined,
		inputHash: string,
	): Promise<ActionStatus> {
		if (action.getStatus === undefined) {
			throw new Error(
				`Verify action '${action.name}' has no getStatus — that's the only thing it does`,
			);
		}
		const status = await action.getStatus(ctx);
		if (status.ok) {
			await applyProvidesRegistry(action, ctx);
			const identity = await captureIdentity(action, ctx, base, prior?.identity, inputHash);
			this.state.set(action.name, {
				lastInputHash: inputHash,
				status: 'ok',
				lastRunAt: Date.now(),
				identity,
			});
			return 'ok';
		}
		this.state.set(action.name, { lastInputHash: inputHash, status: 'failed' });
		throw new Error(`Verify '${action.name}' failed: ${status.detail ?? 'no detail provided'}`);
	}

	/** Try to short-circuit on cold-cycle `getStatus.ok=true` or warm
	 * hash-match. Returns `'ok'` when the skip applies, `undefined` when
	 * the caller should fall through to running the action. The
	 * `getStatus` contract is "read-only probe returning {ok, detail}";
	 * a throw is ambiguous (transient blip vs. real misconfiguration), so
	 * we treat it as `{ok: false}` and let `run` recover rather than
	 * permanently failing. */
	private async tryWarmPathSkip(
		action: Action,
		ctx: ActionRunContext,
		base: ReconcileBaseContext,
		prior: ActionState | undefined,
		hashMatches: boolean,
		inputHash: string,
	): Promise<ActionStatus | undefined> {
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
				const identity = await captureIdentity(action, ctx, base, prior?.identity, inputHash);
				this.state.set(action.name, {
					lastInputHash: inputHash,
					status: 'ok',
					lastRunAt: prior?.lastRunAt,
					identity,
				});
				return 'ok';
			}
			return undefined;
		}
		if (hashMatches && action.getStatus === undefined && prior !== undefined) {
			await applyProvidesRegistry(action, ctx);
			// Re-capture identity on the warm-path-skip branch too:
			// upstream identities are stable here (their hash already
			// gates this skip), but the action's OWN identity may derive
			// from runtime state (e.g. chainId via RPC) that we want
			// refreshed in the manifest.
			const identity = await captureIdentity(action, ctx, base, prior.identity, inputHash);
			this.state.set(action.name, { ...prior, status: 'ok', identity });
			return 'ok';
		}
		return undefined;
	}

	/** Cold-cycle run path: invokes `action.run`, then re-applies
	 * `provides.registry` (so plugins factor their registration into one
	 * function shared by both `run` and the warm-path skip), captures
	 * identity for cascade signals, and updates persistent state. */
	private async runAction(
		action: Action,
		ctx: ActionRunContext,
		base: ReconcileBaseContext,
		prior: ActionState | undefined,
		inputHash: string,
	): Promise<ActionStatus> {
		if (action.run === undefined) {
			await applyProvidesRegistry(action, ctx);
			const identity = await captureIdentity(action, ctx, base, prior?.identity, inputHash);
			this.state.set(action.name, {
				lastInputHash: inputHash,
				status: 'ok',
				identity,
			});
			return 'ok';
		}
		try {
			await action.run(ctx);
			await applyProvidesRegistry(action, ctx);
			const identity = await captureIdentity(action, ctx, base, prior?.identity, inputHash);
			this.state.set(action.name, {
				lastInputHash: inputHash,
				status: 'ok',
				lastRunAt: Date.now(),
				identity,
			});
			return 'ok';
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
			if (entry.status !== 'ok') continue;
			if (entry.lastInputHash === undefined) continue;
			out[name] = {
				lastInputHash: entry.lastInputHash,
				...(entry.lastRunAt === undefined ? {} : { lastRunAt: entry.lastRunAt }),
				...(entry.identity === undefined ? {} : { identity: entry.identity }),
			};
		}
		return out;
	}
}

/** Resolve an action's identity. Default = the action's `inputHash`,
 * which already folds in upstream identities — so cascades propagate
 * transitively without every plugin author having to write an
 * `identity` callback. Explicit `identity(ctx)` overrides for cases
 * where the meaningful change signal isn't input-derived (chainId via
 * RPC, parsed file content, on-chain object id).
 *
 * Best-effort: a transient throw from the explicit hook keeps the
 * prior persisted value, so a single bad cycle doesn't wipe a
 * downstream's cascade signal. */
async function captureIdentity(
	action: Action,
	ctx: ActionRunContext,
	base: ReconcileBaseContext,
	prior: string | undefined,
	inputHash: string,
): Promise<string> {
	if (action.identity === undefined) return inputHash;
	try {
		const explicit = await action.identity(ctx);
		return explicit ?? inputHash;
	} catch (err) {
		base.appendLog?.(
			action.name,
			`identity threw — keeping prior value: ${err instanceof Error ? err.message : String(err)}`,
		);
		return prior ?? inputHash;
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
/** Per-action `Registry` proxy. Stamps `providedBy: actionName` onto
 * every `register()` call — for the three core kinds (services, packages,
 * accounts) AND for plugin-namespaced kinds reached via `registry.ns(...)`
 * or the `defineRegistryKind` accessor. Without the namespace coverage,
 * the renderer's "group by providedBy" was second-class for any item
 * registered through `arena.sharedObjects`, `seal.keyServer`, etc.
 *
 * Implemented as a Proxy (not a plain object spread) because plugins
 * cast `ctx.registry as InternalRegistry` to access non-public methods
 * (`snapshot()` from codegen, `flushDirty()` / `consumeDirty()` from
 * the reconciler itself). A spread would lose the prototype methods
 * and break those casts at runtime. */
function wrapRegistryForAction(registry: Registry, actionName: string): Registry {
	const stamp = <T extends { name: string; providedBy?: string }>(
		query: RegistryQuery<T>,
	): RegistryQuery<T> =>
		new Proxy(query, {
			get(t, prop, receiver) {
				if (prop === 'register') {
					return (item: T) =>
						t.register({ ...item, providedBy: item.providedBy ?? actionName });
				}
				const value = Reflect.get(t, prop, receiver);
				return typeof value === 'function' ? value.bind(t) : value;
			},
		}) as RegistryQuery<T>;
	const wrappedServices = stamp(registry.services);
	const wrappedPackages = stamp(registry.packages);
	const wrappedAccounts = stamp(registry.accounts);

	/** Wrap a namespaced bag so each kind's `register()` stamps
	 * `providedBy`. The bag itself is a Proxy that auto-creates queries
	 * on string-property access; we intercept that get and stamp the
	 * returned query before handing it back. */
	const wrapNs = <T>(bag: T): T =>
		new Proxy(bag as object, {
			get(target, kindProp, receiver) {
				const q = Reflect.get(target, kindProp, receiver) as
					| RegistryQuery<{ name: string; providedBy?: string }>
					| undefined;
				if (q === undefined || typeof kindProp !== 'string') return q;
				return stamp(q);
			},
		}) as T;

	return new Proxy(registry, {
		get(target, prop, receiver) {
			if (prop === 'services') return wrappedServices;
			if (prop === 'packages') return wrappedPackages;
			if (prop === 'accounts') return wrappedAccounts;
			if (prop === 'ns') {
				// Bind so `target.ns(name)` resolves correctly inside
				// `RegistryImpl`'s closure-captured `this`, then wrap the
				// returned bag so namespaced-kind register() stamps too.
				const ns = (target.ns as Registry['ns']).bind(target);
				return <T>(name: string): T => wrapNs(ns<T>(name));
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

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
	const hook = action.provides?.registry;
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
