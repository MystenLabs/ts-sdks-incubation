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
// In addition to TUI state, the engine carries a `restartSignal` that the
// file-watcher (Feature 2: hot-restart) and the TUI keypress / SIGUSR2
// handlers (Feature 3: force-run) push into to request a teardown +
// rebuild of the whole devstack. `defineDevstack.launchEffect` reads the
// signal in its outer loop.

import { Cause, Context, Deferred, Effect, Layer, Ref } from 'effect';
import { EndpointRegistry, type EndpointRecord, type RegistryShape } from './registries.js';
import type {
	BuildStatus,
	TuiEndpoint,
	TuiEntry,
	TuiEntryKind,
	TuiHeader,
	TuiLog,
	TuiState,
} from '../tui/render.js';
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
	 * Resolved when something has asked the devstack to restart (file change,
	 * TUI keypress, SIGUSR2). `defineDevstack` awaits this inside its outer
	 * launch loop and calls `resetRestartSignal` before the next iteration.
	 */
	readonly restartSignal: Ref.Ref<Deferred.Deferred<void>>;
	/** Request a full restart. Idempotent — repeat calls in the same cycle are no-ops. */
	readonly requestRestart: Effect.Effect<void>;
	/** Allocate a fresh Deferred for the next iteration. Called by the launch
	 * loop after `Deferred.await` returns and before re-seeding tags. */
	readonly resetRestartSignal: Effect.Effect<void>;
	/**
	 * Tags that triggered the pending restart, by primitive key. Populated by
	 * the file-watcher fiber when an event resolves to one or more primitives
	 * via their declared `__watchPaths`; read by the next cycle's launch
	 * effect for diagnostic / status-surfacing purposes. Empty when the
	 * trigger was the TUI `r` key, SIGUSR2, or a watch event whose path
	 * didn't match any primitive (a path from `config.watch` rather than a
	 * primitive-declared watch). Cleared by `resetRestartSignal` so a fresh
	 * cycle starts with no inherited attribution.
	 */
	readonly changedTags: Ref.Ref<ReadonlyArray<string>>;
	/** Add primitive keys to `changedTags`. De-duped. */
	readonly notifyChangedTags: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class EngineHandle extends Context.Service<EngineHandle, EngineHandleShape>()(
	'@devstack/EngineHandle',
) {}

// Bound on the rolling log buffer. Failures during long-running dev
// sessions (or noisy hot-restart cycles) shouldn't grow the Ref without
// limit; the TUI only renders the trailing tail anyway.
const LOG_BUFFER_LIMIT = 200;

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
		// Boxed in a Ref so the launch loop can swap in a fresh Deferred per
		// iteration without rebuilding the whole EngineLive layer — keeping
		// the EngineHandle identity stable across hot-restart cycles is what
		// lets the TUI keep rendering through the teardown / rebuild.
		const restartSignal = yield* Ref.make(yield* Deferred.make<void>());
		// Attribution of which primitive(s) the most recent file-watch event
		// resolved to. The watcher fiber writes here BEFORE firing
		// `requestRestart`; the next cycle's launch reads it for diagnostic
		// logging. Cleared on `resetRestartSignal` so each cycle starts with
		// fresh attribution.
		const changedTags = yield* Ref.make<ReadonlyArray<string>>([]);
		const notifyChangedTags = (keys: ReadonlyArray<string>) =>
			Ref.update(changedTags, (existing) => {
				if (keys.length === 0) return existing;
				const merged = new Set([...existing, ...keys]);
				return Array.from(merged);
			});

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
				// needs after ready).
				const patch: Partial<TuiEntry> = {
					status: 'ready',
					phase: undefined,
					lastLog: undefined,
					...(display?.title !== undefined ? { title: display.title } : {}),
					...(display?.primary !== undefined ? { primary: display.primary } : {}),
					...(display?.extras !== undefined ? { extras: display.extras } : {}),
					...(display?.endpoints !== undefined ? { endpoints: display.endpoints } : {}),
				};
				return updateEntry(s, name, patch);
			});

		const markFailed = (name: string, cause: Cause.Cause<unknown>) =>
			Ref.update(tuiState, (s) =>
				updateEntry(s, name, {
					status: 'failed',
					phase: undefined,
					error: summarizeCause(cause),
				}),
			);

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

		const requestRestart = Effect.gen(function* () {
			// Atomic capture-and-replace. The previous read-then-succeed
			// could race `resetRestartSignal`: if the launch loop swapped
			// in a fresh deferred between our `Ref.get` and our
			// `Deferred.succeed`, we'd succeed an orphan deferred and the
			// new one would never wake — losing the restart request.
			// `Ref.getAndSet` does the swap in one critical section, so
			// the deferred we hand to `Deferred.succeed` is guaranteed to
			// no longer be in the ref. A concurrent reset that fires
			// after our swap will see our `fresh`, replace it again, and
			// neither side loses a wake-up.
			const fresh = yield* Deferred.make<void>();
			const old = yield* Ref.getAndSet(restartSignal, fresh);
			yield* Deferred.succeed(old, void 0);
		});

		const resetRestartSignal = Effect.gen(function* () {
			const fresh = yield* Deferred.make<void>();
			yield* Ref.set(restartSignal, fresh);
			// Clear watch-event attribution so the next cycle starts fresh —
			// a stale `changedTags` value from cycle N would mislead cycle N+1's
			// diagnostic surface into thinking the same primitives triggered
			// when in fact this restart was the user pressing `r`.
			yield* Ref.set(changedTags, []);
		});

		return {
			tuiState,
			markAcquiring,
			markReady,
			markFailed,
			markAllReady,
			seedTags,
			appendLog,
			appendTagLog,
			setEntryTitle,
			setHeader,
			setBuildStatus,
			setPhase,
			restartSignal,
			requestRestart,
			resetRestartSignal,
			changedTags,
			notifyChangedTags,
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
