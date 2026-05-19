// Engine — runtime orchestrator that owns the shared mutable state the
// TUI renders from. It tracks two things:
//
//   1. A list of TUI entries — one per top-level `config.stack` member,
//      plus any inner tags whose build fires. Each entry carries:
//        - status     : pending → acquiring → ready (or failed)
//        - kind       : service | action | other (drives section grouping)
//        - title/primary/extras : user-facing projection captured at
//          ready-time from the primitive's `display` selector
//      `tag.ts`'s `tag` / `provide` wrap each primitive's build
//      Effect with engine hooks so transitions fire automatically.
//
//   2. The endpoint list — surfaced for primitives that register URLs
//      without a Service-shaped tag in front of them (today: nothing,
//      retained for the manifest sidecar's benefit only).
//
// In addition to TUI state, the engine carries a restart signal that the
// file-watcher (Feature 2: hot-restart) and the TUI keypress / SIGUSR2
// handlers (Feature 3: force-run) push into to request a teardown +
// rebuild of the whole devstack. `defineDevstack.launchEffect` reads the
// signal in its outer loop via `awaitRestart`.

import { Cause, Context, Deferred, Effect, Exit, Layer, Queue, Ref, Scope } from 'effect';
import { EndpointRegistry, type EndpointRecord, type RegistryShape } from './registries.js';
import type {
	BuildStatus,
	TuiEndpoint,
	TuiEntry,
	TuiEntryKind,
	TuiHeader,
	TuiLog,
	TuiState,
} from './tui-state.js';
import type { TagKind, TuiDisplay } from '../advanced/tag.js';

// -----------------------------------------------------------------------------
// EngineHandle service
// -----------------------------------------------------------------------------

export interface EngineHandleShape {
	readonly tuiState: Ref.Ref<TuiState>;
	/**
	 * Flip a tag pending → acquiring. Idempotent. The optional `kind`
	 * sticks to the entry (service/action) for section grouping; an
	 * unclassified primitive lands in the 'other' section.
	 */
	readonly markAcquiring: (name: string, kind?: TagKind) => Effect.Effect<void>;
	/**
	 * Flip a tag acquiring → ready. Idempotent. The optional `display`
	 * is the primitive's projection of its resolved value into title /
	 * primary / extras — see `TuiDisplay` in `src/tag.ts`.
	 */
	readonly markReady: (name: string, display?: TuiDisplay) => Effect.Effect<void>;
	/**
	 * Push a sub-phase narration onto an entry while it's `acquiring`
	 * — e.g. `'building image'`, `'starting container'`, `'running
	 * genesis'`. Renders inline next to the `acquiring` badge so users
	 * can see WHAT a multi-step primitive is doing. Cleared automatically
	 * when the row transitions to `ready` or `failed`. Idempotent; an
	 * unknown key is silently dropped (no auto-register — phases are
	 * pure narration on top of an existing entry).
	 */
	readonly setPhase: (key: string, phase: string) => Effect.Effect<void>;
	/**
	 * Flip a tag → failed and stash a short one-line message extracted from
	 * `cause` (~60 chars) on the entry; the full prettyError walk is the
	 * caller's responsibility (`appendLog` separately, OR via `appendTagLog`).
	 */
	readonly markFailed: (name: string, cause: Cause.Cause<unknown>) => Effect.Effect<void>;
	/**
	 * Flip a tag ready → stopping. Called by long-lived primitives'
	 * stop finalizers BEFORE `docker stop` fires so the TUI can render
	 * the row as in-flight teardown (yellow "stopping" badge), and the
	 * Footer's "waiting on N containers" count excludes the row.
	 */
	readonly markStopping: (name: string) => Effect.Effect<void>;
	/**
	 * Flip a tag stopping → stopped. Called by long-lived primitives'
	 * stop finalizers AFTER `docker stop` returns. Row renders dim/grey
	 * to confirm the container is gone; Footer count drops by one.
	 */
	readonly markStopped: (name: string) => Effect.Effect<void>;
	/**
	 * Safety net: flip any leftover `pending` / `acquiring` tag to `ready`.
	 * Called by `defineDevstack` after `Layer.build` completes in case a
	 * primitive used a hand-rolled Layer that bypassed the `tag` wrap.
	 */
	readonly markAllReady: Effect.Effect<void>;
	/**
	 * Replace the initial entry list. Called each launch (incl. after a
	 * hot-restart). Pre-classifies each entry's kind so the TUI shows the
	 * Services / Actions sections immediately, before the first primitive
	 * starts acquiring. The optional `title` seeds the friendly label
	 * BEFORE any `markAcquiring`/`setEntryTitle` runs, so a `pending` row
	 * already reads `sui.localnet` rather than the raw internal key
	 * `@devstack/Sui`.
	 */
	readonly seedTags: (
		entries: ReadonlyArray<{
			readonly key: string;
			readonly kind?: TagKind;
			readonly title?: string;
			readonly plugin?: string;
		}>,
	) => Effect.Effect<void>;
	/**
	 * Append a log entry to the TUI's rolling buffer. The buffer is trimmed
	 * to `LOG_BUFFER_LIMIT` to keep memory bounded across long-running stacks
	 * and noisy hot-restart cycles.
	 */
	readonly appendLog: (entry: TuiLog) => Effect.Effect<void>;
	/**
	 * Push a log line that's attributed to a specific tag — surfaces as the
	 * entry's detail-column tail in the dashboard AND appended to the global
	 * log stream. Used by `withEngineLifecycle` for per-primitive status
	 * narration without duplicating the line three times.
	 */
	readonly appendTagLog: (name: string, entry: TuiLog) => Effect.Effect<void>;
	/** Stamp a static friendly title on a row BEFORE its `display(value)`
	 * selector runs. Lets primitives surface `accounts.alice` instead of the
	 * raw key `account/alice` while still acquiring. */
	readonly setEntryTitle: (name: string, title: string) => Effect.Effect<void>;
	/** Patch the persistent header (app / stack / network / buildStatus / cycle). */
	readonly setHeader: (patch: Partial<TuiHeader>) => Effect.Effect<void>;
	/** Bump the build-status. Surfaces in the header tint + footer copy. */
	readonly setBuildStatus: (status: BuildStatus) => Effect.Effect<void>;
	/**
	 * Block until the user has asked the devstack to do a FULL rebuild
	 * (TUI `r` keypress, SIGUSR2). `defineDevstack` yields this in its
	 * outer launch loop between cycles. Backed by a `Queue.dropping(1)`,
	 * so a `requestRestart` that lands between consecutive `awaitRestart`
	 * calls is preserved in the queue and the next await returns
	 * immediately. Closes the lost-wake-up window the previous
	 * `Ref<Deferred>` design had between `Deferred.await` returning and a
	 * separate `Ref.set` of a fresh deferred.
	 *
	 * File-change-driven restarts do NOT go through this surface — Phase
	 * 3 of selective-restart routes watch-fires through
	 * `invalidateSubset` instead. The `r` gesture is the explicit "tear
	 * down everything" path; watch-fires are surgical.
	 */
	readonly awaitRestart: Effect.Effect<void>;
	/** Request a FULL restart (the user-driven `r` gesture and SIGUSR2).
	 * Non-blocking: offers into the dropping queue — if a request is
	 * already pending, the offer is silently dropped (coalesces concurrent
	 * requests into a single wake). Watch-fires should NOT call this;
	 * they use `invalidateSubset` for targeted teardown. */
	readonly requestRestart: Effect.Effect<void>;
	/**
	 * Block until something has asked the devstack to shut down (TUI `q`
	 * press). One-shot: backed by a `Deferred<void>` so multiple awaits
	 * resolve once `requestShutdown` fires. The supervisor races this
	 * against `awaitRestart`; if shutdown wins, the launch loop returns
	 * cleanly and the outer scope tears down all finalizers in-process,
	 * without going through SIGINT (which had race issues delivering
	 * to NodeRuntime's handler after ink unmounted stdin). Ctrl-C still
	 * works via NodeRuntime.runMain's separate signal handler.
	 */
	readonly awaitShutdown: Effect.Effect<void>;
	/** Request a clean shutdown of the supervisor. Idempotent: subsequent
	 * calls are no-ops once the underlying Deferred has been completed. */
	readonly requestShutdown: Effect.Effect<void>;
	/**
	 * Light up the *affected set* for a selective restart: every entry whose
	 * key is in `keys` gets `selectiveRestart = true`. Drives the dim-animation
	 * hook in the TUI so the user can visually trace the cascade. Unknown
	 * keys are silently dropped (we don't auto-register; the watcher fiber
	 * passes keys derived from the dep graph, which is built from the same
	 * stack members the engine seeded). Keys NOT in the set are left alone
	 * — flag clearing happens automatically on `markReady` / `markFailed`,
	 * so this method is purely additive.
	 *
	 * Watch-fire driven; user-initiated `r` (full rebuild) is NOT a selective
	 * restart and does not call this. Calling with an empty set is a no-op.
	 */
	readonly markSelectiveRestart: (keys: ReadonlySet<string>) => Effect.Effect<void>;
	/**
	 * Record the primitive's ambient layer scope (the Scope forked by
	 * Effect's MemoMap inside `Layer.effect`) on the engine so the
	 * supervisor can close it selectively. Called once per primitive
	 * at the top of `withEngineLifecycle`; subsequent calls for the
	 * same key overwrite (the watcher fiber may rebuild a primitive
	 * mid-cycle via Phase 3's `engine.invalidateSubset`, at which
	 * point Effect's MemoMap forks a fresh scope and re-registers).
	 *
	 * Internal — exposed on `EngineHandle` because the `withEngineLifecycle`
	 * wrap lives inside `provide` (which doesn't have a separate
	 * supervisor channel), but callers outside the wrap shouldn't poke
	 * at this surface.
	 */
	readonly registerPrimitiveScope: (key: string, scope: Scope.Scope) => Effect.Effect<void>;
	/**
	 * Close the recorded primitive scope for `key` and drop the entry.
	 * Runs every finalizer the primitive's build attached to its
	 * scope (containers via `Docker.run`'s `stopFinalizer`, files,
	 * background fibers). Silently no-ops when `key` isn't registered
	 * (e.g. the primitive failed before `registerPrimitiveScope` ran).
	 *
	 * Used by Phase 3's `engine.invalidateSubset` to release just the
	 * affected primitives without touching siblings. The `r` user
	 * gesture closes the supervisor's outer scope, which cascades
	 * through every primitive's scope automatically — `r` does NOT
	 * call this method.
	 *
	 * Internal — Phase 3 wires this to `invalidateSubset`. Not part of
	 * the public/advanced surface.
	 */
	readonly closePrimitiveScope: (key: string) => Effect.Effect<void>;
	/**
	 * Watch-fire-driven, targeted invalidation. For every key in `keys`:
	 *   1. Close the primitive's scope (runs container `docker stop`,
	 *      file finalizers, background fibers — same teardown as a full
	 *      `r` would do, just scoped to one primitive).
	 *   2. Evict the shadow-cache entry so the next consumer's `yield*`
	 *      forces a fresh Layer build (which allocates a new scope via
	 *      Effect's MemoMap and re-runs the primitive's body).
	 *
	 * Callers (the watch fiber in `supervisor.ts`) compute the affected
	 * set as `{ownerKey} ∪ downstreamClosure[ownerKey]` for every owner
	 * matched against the changed path — owners + transitive consumers.
	 * Primitives NOT in the set keep their value, their scope, and their
	 * TUI row state untouched.
	 *
	 * Differs from `requestRestart`: `r` (the user gesture) closes the
	 * supervisor's outer scope, which cascades through every primitive's
	 * scope automatically. `invalidateSubset` is the watch-driven path,
	 * and is the ONLY surface that touches primitives selectively.
	 *
	 * Unknown keys are silently dropped (no error — the dep graph + the
	 * engine's scope registry might disagree if a primitive failed
	 * before reaching `registerPrimitiveScope`, but that's not a fatal
	 * condition; a missing scope just means there's nothing to close).
	 * An empty set is a no-op (`yield* engine.markSelectiveRestart` and
	 * `engine.requestRestart` shouldn't fire at all for an empty
	 * affected set — supervisor handles that decision).
	 */
	readonly invalidateSubset: (keys: ReadonlySet<string>) => Effect.Effect<void>;
	/**
	 * Close every registered primitive scope CONCURRENTLY. Called by the
	 * supervisor's shutdown path (q-keypress race + SIGINT `onInterrupt`)
	 * to bypass the sequential close cascade that the user-stack's
	 * `Layer.provideMerge` chain otherwise imposes — each primitive's
	 * `docker stop` (sui=30s, walrus=20s, seal=15s, …) runs as the long
	 * pole of its layer-scope close, so serial teardown is sum(grace) ≈
	 * 65s+ while the parallel variant is max(grace) ≈ 30s.
	 *
	 * Idempotent: closing a scope twice is a no-op for the second call
	 * (Scope marks Closed on first close), so the supervisor invoking
	 * this BEFORE the outer scope cascade is safe — the cascade fires
	 * later, but every primitive scope is already Closed.
	 */
	readonly invalidateAll: Effect.Effect<void>;
	/**
	 * Internal shadow-cache surface — exposed for tests only. The map
	 * mirrors Effect's MemoMap by tag identity; eviction operates on
	 * the shadow cache only. The MemoMap is treated as a black box and
	 * is NOT mutated by `invalidateSubset` (per
	 * `notes/selective-restart.md` § "Decisions baked into this plan").
	 *
	 * Production callers should never read this — they use
	 * `invalidateSubset` to evict and let the engine's
	 * `registerPrimitiveScope` re-populate. The Ref is exported only
	 * so the engine.test.ts shadow-cache-shape assertions can inspect
	 * eviction semantics without poking at private state through
	 * unsafe casts.
	 */
	readonly _shadowCache: Ref.Ref<ReadonlyMap<string, unknown>>;
}

export class EngineHandle extends Context.Service<EngineHandle, EngineHandleShape>()(
	'@devstack/EngineHandle',
) {}

// Bound on the rolling log buffer. Failures during long-running dev
// sessions (or noisy hot-restart cycles) shouldn't grow the Ref without
// limit; the TUI only renders the trailing tail anyway.
const LOG_BUFFER_LIMIT = 200;

// Sentinel value stored in the shadow cache to mark "this primitive
// has been built and is live in the MemoMap." We only ever check
// presence (`Map.has` / `Map.delete`), so the value is opaque — the
// engine doesn't get to peek at primitives' resolved shapes (those
// live in the MemoMap entry the consumer's `yield*` resolves
// against). Symbol-typed so a future bug that tries to read it as a
// real value fails loudly rather than silently corrupting state.
const SHADOW_CACHE_PRESENT: unique symbol = Symbol('@devstack/shadow-cache-present');

const defaultHeader: TuiHeader = Object.freeze({
	app: '',
	stack: 'main',
	network: 'localnet',
	buildStatus: 'idle',
	cycle: 0,
});

// Deep-frozen so a future bug that tries to mutate in place fails loudly
// instead of silently corrupting the singleton seed value.
const emptyState: TuiState = Object.freeze({
	entries: Object.freeze([]) as ReadonlyArray<TuiEntry>,
	endpoints: Object.freeze([]) as ReadonlyArray<TuiEndpoint>,
	logs: Object.freeze([]) as ReadonlyArray<TuiLog>,
	header: defaultHeader,
});

const toEntryKind = (kind: TagKind | undefined): TuiEntryKind => kind ?? 'other';

// Build a fresh entry preserving any prior display/title fields. The
// engine merges updates — markReady carries the display, markAcquiring
// only the kind — so a status flip late in the lifecycle doesn't drop
// the URL the build already emitted.
const mergeEntry = (
	prior: TuiEntry | undefined,
	patch: Partial<TuiEntry> & { readonly key: string },
): TuiEntry => {
	const base: TuiEntry = prior ?? { key: patch.key, kind: 'other', status: 'pending' };
	return { ...base, ...patch };
};

const updateEntry = (state: TuiState, key: string, patch: Partial<TuiEntry>): TuiState => {
	// Auto-register entries we've never seen before. `defineDevstack` seeds
	// the top-level stack members, but inner tags built at factory time
	// (e.g. seal's keyServer / keyManager projections, or the per-account
	// tags inside an `accounts({...})` handle) fire `markAcquiring` for
	// keys that aren't in the initial seed list. Treat that as "first time
	// we've heard of this tag — start tracking it" rather than dropping the
	// status update on the floor.
	const exists = state.entries.some((t) => t.key === key);
	if (!exists) {
		return { ...state, entries: [...state.entries, mergeEntry(undefined, { ...patch, key })] };
	}
	return {
		...state,
		entries: state.entries.map((t) => (t.key === key ? mergeEntry(t, { ...patch, key }) : t)),
	};
};

// Cap on the per-tag inline error summary so a long stderr can't blow up the
// row layout. The full multi-line walk lives only in the global log stream.
const ERROR_SUMMARY_MAX = 80;

// Walk an unknown error value's `.cause` chain to the deepest non-empty
// node so the row surfaces the ACTUAL reason (docker stderr, sui-cli's
// "unexpected argument '--json' found", …) instead of the outermost
// `failed to start sui localnet container: …` wrapper. Tagged-error
// `stderr` beats `message` because our `DockerError` / `SuiCliError`
// stamp the stderr field at construction time and that's the real cli
// output the user needs.
const extractDeepestMessage = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	// Cause.prettyErrors materializes nested `.cause` chains as Error
	// instances; recurse into the Error first, then fall through.
	if (typeof value === 'object') {
		const obj = value as { readonly cause?: unknown };
		if (obj.cause !== undefined) {
			const deeper = extractDeepestMessage(obj.cause);
			if (deeper !== undefined && deeper.length > 0) return deeper;
		}
		const tagged = value as {
			readonly stderr?: unknown;
			readonly message?: unknown;
		};
		if (typeof tagged.stderr === 'string' && tagged.stderr.trim().length > 0) {
			return tagged.stderr.trim();
		}
		if (typeof tagged.message === 'string' && tagged.message.length > 0) {
			return tagged.message;
		}
	}
	if (typeof value === 'string' && value.length > 0) return value;
	return undefined;
};

// Cause → one-line ROOT-cause message for the TUI row. The previous
// implementation returned the outermost wrapper's `message`, which in our
// codebase always reads `<Primitive>(<name>): <generic preamble>: <real
// reason>` — the row's 60-char budget got eaten before the real reason
// ever fit. Walking the `.cause` chain inside `Cause.prettyErrors[0]` (or
// the raw failure when prettyErrors gives nothing back) surfaces the
// deepest message: the docker stderr, the sui-cli's flag rejection, the
// faucet's HTTP body, etc.
const summarizeCause = (cause: Cause.Cause<unknown>): string => {
	const errors = Cause.prettyErrors(cause);
	const head = errors[0];
	const deepest =
		(head !== undefined ? extractDeepestMessage(head) : undefined) ??
		extractDeepestMessage(rawFailure(cause)) ??
		(head !== undefined ? head.message : Cause.pretty(cause));
	const firstLine = deepest.split('\n')[0] ?? deepest;
	if (firstLine.length <= ERROR_SUMMARY_MAX) return firstLine;
	return `${firstLine.slice(0, ERROR_SUMMARY_MAX - 1)}…`;
};

// `Cause.prettyErrors` strips our `_tag` + `stderr` fields onto an Error
// instance, but it walks via `Object.keys(original)` — own enumerable
// only. Schema.TaggedErrorClass instances mostly satisfy that, but if the
// inner cause is a non-Error object (e.g. our `SignAndExecuteError`
// plain-object discriminated-union) it falls through to `formatJson`.
// Pulling the first `Fail` reason's raw payload sidesteps the lossy
// projection so `extractDeepestMessage` walks our original tree.
const rawFailure = (cause: Cause.Cause<unknown>): unknown => {
	for (const reason of cause.reasons) {
		const r = reason as {
			readonly _tag: string;
			readonly error?: unknown;
			readonly defect?: unknown;
		};
		if (r._tag === 'Fail') return r.error;
		if (r._tag === 'Die') return r.defect;
	}
	return undefined;
};

export const EngineLive: Layer.Layer<EngineHandle> = Layer.effect(
	EngineHandle,
	Effect.gen(function* () {
		const tuiState = yield* Ref.make<TuiState>(emptyState);
		// `Queue.dropping(1)` of unit values: the producer side
		// (`requestRestart`) offers non-blockingly and the queue's internal
		// state preserves the pending wake across the consumer's
		// `take`/process gap. Lost-wake-up is impossible because the queue
		// itself is the synchronisation primitive — there's no separate
		// "currently armed" deferred reference that can fall out of sync
		// with what the loop is awaiting.
		const restartQueue = yield* Queue.dropping<void>(1);
		// One-shot shutdown signal. The supervisor's launch loop races this
		// against `awaitRestart`; if shutdown wins, the loop returns and the
		// outer Effect.scoped tears down all finalizers in-process. Replaces
		// the previous q-handler dependency on `process.kill(SIGINT)`, which
		// could lose the race with ink's stdin detach during `inkApp.exit()`
		// (NodeRuntime's SIGINT handler installed but the supervisor fiber
		// had already moved past the interruptible await point).
		const shutdownSignal = yield* Deferred.make<void>();
		// Re-seeding clears the previous run's terminal statuses so a
		// hot-restart cycle starts every tag fresh at `pending`. The
		// caller pre-classifies each member as service/action so the TUI
		// renders the Services / Actions sections before the first
		// primitive starts acquiring (empty rows instead of an empty
		// dashboard while pulls happen).
		const seedTags = (
			entries: ReadonlyArray<{
				readonly key: string;
				readonly kind?: TagKind;
				readonly title?: string;
				readonly plugin?: string;
			}>,
		) =>
			Ref.update(tuiState, (s) => ({
				...s,
				entries: entries.map(
					(e): TuiEntry => ({
						key: e.key,
						kind: toEntryKind(e.kind),
						status: 'pending' as const,
						...(e.title !== undefined ? { title: e.title } : {}),
						...(e.plugin !== undefined ? { plugin: e.plugin } : {}),
					}),
				),
			}));

		const markAcquiring = (name: string, kind?: TagKind) =>
			Ref.update(tuiState, (s) =>
				updateEntry(s, name, { status: 'acquiring', kind: toEntryKind(kind) }),
			);

		const markReady = (name: string, display?: TuiDisplay) =>
			Ref.update(tuiState, (s) => {
				// Terminal transitions clear the sub-phase AND the last
				// transient log line. A row that's already `ready`
				// showing `(running genesis)` next to its URL would be
				// confusing — the phase narration only makes sense
				// alongside the `acquiring` badge. Same for `lastLog`:
				// a debug line emitted mid-acquire would otherwise stick
				// around in the row's detail column AND mask the
				// resolved primary URL (the field the user actually
				// needs after ready). Also clears `selectiveRestart` so
				// the cascade animation only lights up the row while it's
				// actually re-acquiring; the next watch-fire will set it
				// again if this primitive is in the affected set.
				const patch: Partial<TuiEntry> = {
					status: 'ready',
					phase: undefined,
					lastLog: undefined,
					selectiveRestart: undefined,
					...(display?.title !== undefined ? { title: display.title } : {}),
					...(display?.primary !== undefined ? { primary: display.primary } : {}),
					...(display?.extras !== undefined ? { extras: display.extras } : {}),
					...(display?.endpoints !== undefined ? { endpoints: display.endpoints } : {}),
					...(display?.plugin !== undefined ? { plugin: display.plugin } : {}),
				};
				return updateEntry(s, name, patch);
			});

		const markFailed = (name: string, cause: Cause.Cause<unknown>) =>
			Ref.update(tuiState, (s) =>
				updateEntry(s, name, {
					status: 'failed',
					phase: undefined,
					selectiveRestart: undefined,
					error: summarizeCause(cause),
				}),
			);

		// Teardown transitions. Both are best-effort — a row that's not in
		// state (e.g. a primitive that never reached `ready`) gets a fresh
		// pending-shaped entry rather than failing. The TUI's Footer
		// "waiting on N containers" count subtracts `stopping` + `stopped`
		// rows so the user sees containers fall off as docker confirms the
		// exit; row rendering greys out stopped rows so the dashboard
		// gracefully decays during teardown instead of staring static.
		const markStopping = (name: string) =>
			Ref.update(tuiState, (s) =>
				updateEntry(s, name, {
					status: 'stopping',
					phase: undefined,
					lastLog: undefined,
					selectiveRestart: undefined,
				}),
			);
		const markStopped = (name: string) =>
			Ref.update(tuiState, (s) =>
				updateEntry(s, name, {
					status: 'stopped',
					phase: undefined,
					lastLog: undefined,
					selectiveRestart: undefined,
				}),
			);

		// Light up the affected set for a selective restart. See the
		// EngineHandleShape JSDoc for semantics. Set-based input keeps the
		// call-site free of de-dupe concerns (the watcher fiber unions
		// owner ∪ downstreamClosure[ownerKey], which can produce overlaps
		// across multiple matched owners).
		const markSelectiveRestart = (keys: ReadonlySet<string>) =>
			Ref.update(tuiState, (s) => {
				if (keys.size === 0) return s;
				// Only touch rows the engine already knows about. Unknown keys
				// (e.g. an out-of-date dep graph carrying a stale entry) are
				// silently dropped — selective-restart is a UX hint, not a
				// correctness gate, so a missing row shouldn't spawn a ghost.
				return {
					...s,
					entries: s.entries.map((t) => (keys.has(t.key) ? { ...t, selectiveRestart: true } : t)),
				};
			});

		// Silently drop updates for unknown keys: phases are pure
		// narration over an existing acquire, so a stray
		// `yield* setPhase(...)` from a primitive that wasn't seeded
		// (test, hand-rolled escape hatch) shouldn't auto-register a
		// new entry the way `markAcquiring` does — the row would have
		// no kind / title and render confusingly.
		const setPhase = (name: string, phase: string) =>
			Ref.update(tuiState, (s) => {
				if (!s.entries.some((e) => e.key === name)) return s;
				return {
					...s,
					entries: s.entries.map((e) => (e.key === name ? { ...e, phase } : e)),
				};
			});

		const appendLog = (entry: TuiLog) =>
			Ref.update(tuiState, (s) => {
				const next = [...s.logs, entry];
				const trimmed = next.length > LOG_BUFFER_LIMIT ? next.slice(-LOG_BUFFER_LIMIT) : next;
				return { ...s, logs: trimmed };
			});

		// Per-tag log: surfaces in the row's detail column AND the global tail.
		// Single write so the two views can't drift.
		const appendTagLog = (name: string, entry: TuiLog) =>
			Ref.update(tuiState, (s) => {
				const next = [...s.logs, entry];
				const trimmed = next.length > LOG_BUFFER_LIMIT ? next.slice(-LOG_BUFFER_LIMIT) : next;
				const withTag = updateEntry({ ...s, logs: trimmed }, name, { lastLog: entry.message });
				return withTag;
			});

		// Only flip pre-terminal statuses. Entries already in `ready` or
		// `failed` are preserved verbatim.
		const markAllReady = Ref.update(tuiState, (s) => ({
			...s,
			entries: s.entries.map((t) =>
				t.status === 'pending' || t.status === 'acquiring' ? { ...t, status: 'ready' as const } : t,
			),
		}));

		const setEntryTitle = (name: string, title: string) =>
			Ref.update(tuiState, (s) => updateEntry(s, name, { title }));

		const setHeader = (patch: Partial<TuiHeader>) =>
			Ref.update(tuiState, (s) => ({ ...s, header: { ...s.header, ...patch } }));

		const setBuildStatus = (status: BuildStatus) => setHeader({ buildStatus: status });

		// Offer is non-blocking. With `Queue.dropping(1)`, a second offer
		// while the queue is full silently returns false and is discarded
		// — exactly the "coalesce concurrent requests into one wake"
		// semantic we want.
		const requestRestart = Queue.offer(restartQueue, void 0).pipe(Effect.asVoid);

		// `Queue.take` blocks if the queue is empty and returns
		// immediately if a `requestRestart` had landed since the previous
		// take. The queue itself is the synchronisation primitive — no
		// separate Ref/Deferred to fall out of sync.
		const awaitRestart = Queue.take(restartQueue).pipe(Effect.asVoid);

		const awaitShutdown = Deferred.await(shutdownSignal);
		// `Deferred.done` is idempotent — second calls after the first
		// success are no-ops, so the q-handler can fire this without
		// worrying about double-press or signal handler overlap.
		const requestShutdown = Deferred.done(shutdownSignal, Exit.void).pipe(Effect.asVoid);

		// Per-primitive scope registry — Phase 2 of selective-restart.
		// `withEngineLifecycle` (in `advanced/tag.ts`) calls
		// `registerPrimitiveScope(name, primitiveScope)` at the top of
		// every build so the supervisor knows where each primitive's
		// finalizers live; Phase 3's `engine.invalidateSubset` calls
		// `closePrimitiveScope(key)` to release just the affected
		// primitives without touching siblings.
		//
		// The map's lifetime is the engine's lifetime — `EngineLive`'s
		// build runs on the outer launch scope, so the map persists
		// across `r` hot-restart cycles. Entries removed on
		// `closePrimitiveScope`; re-population happens automatically
		// because the next consumer's `yield*` re-enters the layer build
		// (forced by Phase 3's shadow-cache eviction).
		const primitiveScopes = yield* Ref.make<ReadonlyMap<string, Scope.Scope>>(new Map());
		const registerPrimitiveScope = (key: string, scope: Scope.Scope): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* Ref.update(primitiveScopes, (m) => {
					const next = new Map(m);
					next.set(key, scope);
					return next;
				});
				// Shadow-cache parallel write: every primitive build that
				// makes it past `registerPrimitiveScope` is, by
				// construction, present in Effect's MemoMap (the Layer
				// build forked the scope we just registered). We mark the
				// entry "live" — the value itself is opaque (we only need
				// the presence/absence bit for eviction semantics; the
				// real value lives in the MemoMap entry the consumer's
				// `yield*` resolves against). Sentinel rather than the
				// real value because the engine doesn't get to see the
				// primitive's resolved shape — `withEngineLifecycle` runs
				// at the *top* of the build, before the body runs and
				// before the value exists.
				yield* Ref.update(shadowCache, (m) => {
					const next = new Map(m);
					next.set(key, SHADOW_CACHE_PRESENT);
					return next;
				});
			});
		const closePrimitiveScope = (key: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const current = yield* Ref.get(primitiveScopes);
				const scope = current.get(key);
				if (scope === undefined) return;
				// Drop the entry BEFORE closing so a concurrent re-acquire
				// can re-register without observing a stale scope. Order
				// matters: dropping after `Scope.close` would let a watcher
				// that fired during teardown see the closed scope as
				// "still registered" and skip the close on its turn.
				yield* Ref.update(primitiveScopes, (m) => {
					const next = new Map(m);
					next.delete(key);
					return next;
				});
				yield* Scope.close(scope, Exit.void);
			});

		// Shadow cache — Phase 3 of selective-restart.
		//
		// What this is: a parallel `Map<tagKey, unknown>` mirroring Effect's
		// MemoMap entries by tag identity. Eviction operates on this map ONLY
		// — the MemoMap is treated as a black box and is never mutated by
		// `invalidateSubset` (per `notes/selective-restart.md` § "Decisions
		// baked into this plan": MemoMap key extraction is rejected as too
		// fragile to internal Effect changes).
		//
		// Why: closing a primitive's scope releases its resources, but on
		// its own that doesn't force the next consumer's `yield*` to
		// re-acquire — Effect's MemoMap would replay the cached build
		// result from a closed scope. Evicting the shadow-cache entry is
		// the signal the supervisor uses to know "this entry is dirty;
		// the next cycle's `Layer.buildWithMemoMap` must re-execute its
		// Layer.effect body and allocate a fresh primitive scope."
		//
		// How it stays in sync with MemoMap:
		//   - Populated when `registerPrimitiveScope` lands (parallel
		//     write — every successful Layer.effect build that registers
		//     a scope also writes its shadow-cache entry).
		//   - Evicted on `closePrimitiveScope` (via `invalidateSubset`).
		//     The next watch-fire that re-targets this primitive walks
		//     through `Layer.buildWithMemoMap` which calls the Layer's
		//     `build` again; that re-fires the wrap which re-registers,
		//     re-populating the shadow cache. The MemoMap entry is
		//     evicted in lockstep when the supervisor's outer scope
		//     closes (every cycle, between `r` cycles); the shadow cache
		//     just gives us the per-cycle granularity the MemoMap lacks.
		//
		// Lifetime: same as the engine — `EngineLive`'s build runs on the
		// outer launch scope, so the map persists across `r` hot-restart
		// cycles. `r` itself doesn't read or write this map; it closes
		// the supervisor's outer scope, which cascades into a new MemoMap
		// for the next cycle (the cleanest invalidation surface), so
		// shadow cache continues to mirror reality.
		//
		// Value shape: `unknown` because the engine doesn't model the
		// resolved shape of each primitive. In practice the only operation
		// we run on the map is presence/absence (`.has` / `.delete`), so a
		// sentinel is sufficient — we never read the value.
		const shadowCache = yield* Ref.make<ReadonlyMap<string, unknown>>(new Map());

		const invalidateSubset = (keys: ReadonlySet<string>): Effect.Effect<void> =>
			Effect.gen(function* () {
				if (keys.size === 0) return;
				// Per key: evict the shadow-cache entry BEFORE closing the
				// scope — symmetric with `closePrimitiveScope`'s "drop before
				// close", so a re-acquire concurrent with teardown sees
				// consistent state (shadow absent → re-acquire needed; scope
				// absent → register a fresh one).
				//
				// Closes fire CONCURRENTLY (`Effect.all` with unbounded
				// concurrency). Each primitive's `docker stop` (registered on
				// that primitive's layer scope via `Docker.run`'s
				// `stopFinalizer`) is the slow long pole — running them
				// sequentially compounds grace windows (sui=30s + walrus=20s
				// + seal=15s = ~65s worst case). With per-key concurrency,
				// teardown of N primitives takes ~max(grace_i) instead of
				// ~sum(grace_i). Critical for shutdown path where the
				// supervisor invokes this with every registered key — see
				// `invalidateAll`. Ref.update is atomic so the shadow-cache
				// writes don't race.
				yield* Effect.all(
					Array.from(keys, (key) =>
						Effect.gen(function* () {
							yield* Ref.update(shadowCache, (m) => {
								const next = new Map(m);
								next.delete(key);
								return next;
							});
							yield* closePrimitiveScope(key);
						}),
					),
					{ concurrency: 'unbounded', discard: true },
				);
			});

		// All-keys variant — used by the supervisor's shutdown path to tear
		// down every registered primitive concurrently, bypassing the
		// sequential cascade that `Layer.provideMerge`'s nested fromBuild
		// scopes would otherwise impose on docker-stop finalizers.
		const invalidateAll: Effect.Effect<void> = Effect.gen(function* () {
			const scopes = yield* Ref.get(primitiveScopes);
			const keys = new Set(scopes.keys());
			yield* invalidateSubset(keys);
		});

		return {
			tuiState,
			markAcquiring,
			markReady,
			markFailed,
			markStopping,
			markStopped,
			markAllReady,
			seedTags,
			appendLog,
			appendTagLog,
			setEntryTitle,
			setHeader,
			setBuildStatus,
			setPhase,
			awaitRestart,
			requestRestart,
			awaitShutdown,
			requestShutdown,
			markSelectiveRestart,
			registerPrimitiveScope,
			closePrimitiveScope,
			invalidateSubset,
			invalidateAll,
			// Internal — exported on the shape only for tests. Production
			// callers use `invalidateSubset` (write) and never read the
			// shadow cache directly.
			_shadowCache: shadowCache,
		};
	}),
);

// -----------------------------------------------------------------------------
// EndpointRegistry, engine-aware variant
// -----------------------------------------------------------------------------
//
// Earlier shape pushed every registered endpoint into the TUI state as a
// dedicated section. With Services now surfacing URLs from their own
// `display.primary` selector, that section became redundant — every
// primitive that registers an endpoint also surfaces it via the Services
// row. The registry stays as the source of truth for `manifest.json` and
// internal lookups; the TUI just stops mirroring it.

export const EndpointRegistryWithEngineLive: Layer.Layer<EndpointRegistry, never, EngineHandle> =
	Layer.effect(
		EndpointRegistry,
		Effect.gen(function* () {
			// EngineHandle is still required so the merge order in
			// `defineDevstack` stays stable — the layer doesn't actually
			// touch it anymore, but flipping its R channel back to `never`
			// would shuffle the InfraLive composition.
			yield* EngineHandle;
			const ref = yield* Ref.make<ReadonlyArray<EndpointRecord>>([]);

			const register: RegistryShape<EndpointRecord>['register'] = (entry) =>
				Ref.update(ref, (xs) => [...xs, entry]);

			const snapshot = Ref.get(ref);

			return { register, snapshot };
		}),
	);
