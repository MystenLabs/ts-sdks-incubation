// Projection updater.
//
// Architecture § Renderer § "Subscribable projection — exact field
// enumeration" (G2). The updater is a typed event-handler: each
// `EngineEvent` produces a structurally-typed projection mutation.
// Renderers never see the event taxonomy here; they only see the
// resulting state.
//
// The updater is *pure data*: it takes the old state + an event,
// returns the new state. Atomicity comes from
// `SubscriptionRef.update` at the call site.
//
// Discipline:
//   - No display vocabulary (`title`, `primary`, `extras`) anywhere
//     in the produced state.
//   - All fields the architecture enumerates are reachable; new
//     event tags are picked up via exhaustive `tag` match (the
//     `_exhaustive: never` line will fail to type-check if a new
//     tag is added without a handler here).

import { Effect, Schema, SubscriptionRef } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import { eventAtOrNull } from '../../event-time.ts';
import type { LifecycleFact, LifecycleStatus } from '../../lifecycle.ts';
import type {
	AccountProjection,
	BuildEntry,
	Endpoint,
	PackageProjection,
	Row,
	StructuredError,
	SubscribableState,
} from '../../projection.ts';
import { LogAttr } from '../observability/log-attrs.ts';

// -----------------------------------------------------------------------------
// Per-kind `projection.updated` payload schemas
// -----------------------------------------------------------------------------
//
// The reducer is the projection orchestrator and owns the per-`kind`
// structural decode of `projection.updated` payloads (STYLE_GUIDE §20:
// a misbehaving plugin emitting a malformed payload must NOT crash the
// reducer or the surrounding projection stream — the decode acts as a
// structural guard so a bad slice is dropped, not applied). These two
// schemas mirror `AccountProjection` / `PackageProjection` in
// `substrate/projection.ts`; the runtime brand on `key`
// (`account/${string}` / `package/${string}`) is TS-only and Schema
// can't express it, so callers forward the original `event.payload`
// after a successful decode rather than the decoded (brand-stripped)
// copy.
//
// The plain-renderer reads the raw event stream (not the reduced
// state) and re-runs the same decode for the same payloads; it imports
// these schemas from here, the single canonical definition.

/** Structural schema for a `projection.updated[account]` payload. */
export const AccountProjectionSchema = Schema.Struct({
	key: Schema.String,
	rowKey: Schema.NullOr(Schema.String),
	name: Schema.String,
	address: Schema.NullOr(Schema.String),
	scheme: Schema.NullOr(Schema.Literals(['ed25519', 'secp256k1', 'secp256r1'])),
	source: Schema.NullOr(Schema.Literals(['real', 'impersonate'])),
	funding: Schema.Struct({
		status: Schema.Literals(['pending', 'funded', 'skipped', 'failed', 'unknown']),
		balanceMist: Schema.NullOr(Schema.String),
		requestedMist: Schema.NullOr(Schema.String),
		entries: Schema.optional(
			Schema.Array(
				Schema.Struct({
					coin: Schema.String,
					fullCoinType: Schema.String,
					amount: Schema.String,
					// Mirrors `AccountProjection.funding.entries[].status` in
					// `substrate/projection.ts`. `'already-satisfied'` is
					// the pre-existing-balance short-circuit emitted by the
					// account funding pass — semantically a success, kept
					// distinct from `'funded'` so renderers can surface the
					// cached-vs-fresh distinction.
					status: Schema.Literals(['funded', 'already-satisfied', 'skipped']),
				}),
			),
		),
	}),
	walletVisible: Schema.Boolean,
	updatedAt: Schema.Number,
});

/** Structural schema for a `projection.updated[package]` payload. */
export const PackageProjectionSchema = Schema.Struct({
	key: Schema.String,
	rowKey: Schema.NullOr(Schema.String),
	name: Schema.String,
	kind: Schema.Literals(['local', 'known']),
	packageId: Schema.String,
	upgradeCapId: Schema.NullOr(Schema.String),
	mvrPlaceholder: Schema.String,
	sourcePath: Schema.NullOr(Schema.String),
	updatedAt: Schema.Number,
});

// -----------------------------------------------------------------------------
// Capacity policy
// -----------------------------------------------------------------------------

/** Bounded buffer for the top-level errors list. */
const MAX_ERRORS_KEPT = 100;
/** Bounded buffer for the top-level build-entries list. */
const MAX_BUILD_ENTRIES_KEPT = 200;
/** Per-row bounded log-tail length. Architecture: default 100 lines. */
const MAX_ROW_LOG_LINES = 100;

// -----------------------------------------------------------------------------
// Decode-result type — shared between the reducer's optional pre-flight
// cache and the `tryDecodeProjectionPayload` helper. Hoisted above the
// reducer so the optional `prevalidated` parameter can reference it.
// -----------------------------------------------------------------------------

type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly cause: unknown };

// -----------------------------------------------------------------------------
// LifecycleFact bridge
// -----------------------------------------------------------------------------
//
// `substrate/lifecycle.ts` declares `LifecycleFact` — the merge-not-
// replace per-plugin lifecycle slice the projection consumes. The
// reducer routes lifecycle-shaped events through this typed bridge
// instead of writing each status / phase / restart field
// independently. The reducer for non-lifecycle events is unchanged.

/** Per-plugin fact delta. Each field is optional — only the fields the
 *  source event carries are populated. `applyLifecycleFact` merges a
 *  delta into the existing `Row`. */
export interface LifecycleFactDelta {
	readonly status?: LifecycleStatus;
	readonly phase?: LifecycleFact['phase'];
	readonly selectiveRestartHighlight?: boolean;
}

/** Project a lifecycle-shaped `EngineEvent` into a per-plugin delta.
 *  Returns `null` for events that don't carry lifecycle information so
 *  the reducer can short-circuit. The substrate stays event-name-blind
 *  by routing through this single mapping table. */
export const factFromEvent = (
	event: EngineEvent,
): { readonly pluginKey: PluginKey; readonly delta: LifecycleFactDelta } | null => {
	switch (event.tag) {
		case 'lifecycle.statusChanged':
			return {
				pluginKey: event.pluginKey,
				delta: { status: event.to },
			};
		case 'lifecycle.phaseSet':
			return {
				pluginKey: event.pluginKey,
				delta: { phase: event.phase },
			};
		default:
			// `restart.requested` ALSO updates cycle.phase + clears
			// other rows' highlights — that's a multi-row reducer
			// concern the projection handles directly. We deliberately
			// keep the bridge scoped to the closed `LifecycleFact`
			// shape (status / phase / selectiveRestartHighlight) so
			// callers can derive per-plugin facts without rebuilding
			// the cycle phase too.
			return null;
	}
};

/** Apply a fact delta to a row. Pure. Fields not in the delta are
 *  preserved verbatim — the merge-not-replace shape `LifecycleFact`
 *  promises. */
export const applyLifecycleFact = (row: Row, delta: LifecycleFactDelta): Row => ({
	...row,
	...(delta.status !== undefined ? { status: delta.status } : {}),
	...(delta.phase !== undefined ? { phase: delta.phase } : {}),
	...(delta.selectiveRestartHighlight !== undefined
		? { selectiveRestartHighlight: delta.selectiveRestartHighlight }
		: {}),
});

// -----------------------------------------------------------------------------
// Pure reducer
// -----------------------------------------------------------------------------

/**
 * Pure projection reducer. One event in, one new state out. All field
 * writes preserve `readonly` invariants by constructing fresh
 * objects/arrays rather than mutating.
 *
 * The `tag` switch is exhaustive against `EngineEvent['tag']`; the
 * trailing `_exhaustive: never` causes TS to flag any new tag that
 * isn't handled here.
 *
 * @param prevalidated - Optional pre-flight decode result for
 *   `projection.updated` payloads. When the Effect-aware `updateRef`
 *   seam has already decoded the payload (to drive the warning
 *   emission inside the fiber's logger Layer), it threads the result
 *   here so the reducer doesn't decode the same payload twice on
 *   the hot path. Direct `applyEvent` callers (tests, in-process
 *   projection consumers) leave this undefined and the reducer
 *   re-decodes — the schema is sync + deterministic so the cached
 *   result and a fresh decode agree.
 */
export const applyEvent = (
	state: SubscribableState,
	event: EngineEvent,
	prevalidated?: DecodeResult<unknown>,
): SubscribableState => {
	// Every event advances `lastEvent.at`. `lastEvent.seq` is bumped at
	// the `updateRef` wrapper, not here — this reducer is pure data.
	const withTouched = (next: Partial<SubscribableState>): SubscribableState => ({
		...state,
		...next,
		lastEvent: { seq: state.lastEvent.seq, at: eventAtOrNull(event) ?? state.lastEvent.at },
	});

	// Lifecycle-shaped events flow through the typed `LifecycleFact`
	// bridge — the projection consumes the merge-not-replace fact
	// instead of writing each lifecycle field independently. Non-
	// lifecycle events take their original specialised paths below.
	const fact = factFromEvent(event);
	if (fact !== null) {
		return withTouched({
			rows: upsertRow(state.rows, fact.pluginKey, (row) => applyLifecycleFact(row, fact.delta)),
		});
	}

	switch (event.tag) {
		case 'lifecycle.statusChanged':
		case 'lifecycle.phaseSet':
			// Handled above via `factFromEvent` — kept in the switch for
			// `_exhaustive` discipline.
			return withTouched({});

		case 'log.appended':
			return withTouched({
				rows: upsertRow(state.rows, event.pluginKey, (row) =>
					appendLogLine(row, event.line, event.level),
				),
			});

		case 'endpoint.registered':
			return withTouched({
				endpoints: upsertEndpoint(state.endpoints, event.endpoint),
				rows: attachEndpoint(state.rows, event.endpoint),
			});

		case 'projection.updated':
			// Substrate stays name-blind on the event vocabulary; the
			// reducer is the projection orchestrator and owns the per-
			// `kind` decode. New plugin-author projection kinds slot in
			// here without a new event variant — extending this switch
			// is the load-bearing knob.
			//
			// Per STYLE_GUIDE §20: a misbehaving plugin emitting a
			// malformed payload must NOT crash the reducer or the
			// surrounding projection stream. Decode per-kind via the
			// canonical Schema; on failure, drop the slice update
			// (`lastEvent.at` still advances so the renderer sees the
			// event was observed). Warning emission is handled by the
			// Effect-aware seam at the `updateRef` call site so it runs
			// inside the fiber's structured-logging context — the
			// reducer itself stays pure-data sync (no logger access),
			// just signaling a decode failure via a non-`ok` decode
			// result.
			if (event.kind === 'account') {
				const decoded =
					prevalidated ?? tryDecodeProjectionPayload(AccountProjectionSchema, event.payload);
				// `event.payload` (not `decoded.value`) is forwarded once the
				// schema has confirmed the structural shape — the runtime brand
				// (`account/${string}`) is TS-only and Schema can't express
				// it. The cast is justified by the preceding decode, not a
				// `Schema.decodeUnknownSync(...) as A` bare-cast (§20).
				return decoded.ok
					? withTouched({
							accounts: upsertAccount(state.accounts, event.payload as AccountProjection),
						})
					: withTouched({});
			}
			if (event.kind === 'package') {
				const decoded =
					prevalidated ?? tryDecodeProjectionPayload(PackageProjectionSchema, event.payload);
				return decoded.ok
					? withTouched({
							packages: upsertPackage(state.packages, event.payload as PackageProjection),
						})
					: withTouched({});
			}
			return withTouched({});

		case 'endpoint.released':
			// Renderer projection keeps endpoint history as last-known
			// operator affordance. A released service may no longer be
			// reachable, but hiding the URL during shutdown/restart makes
			// the TUI lose the most useful debugging handle.
			return withTouched({});

		case 'strategy.registered':
		case 'strategy.unregistered':
		case 'manifest.flushed':
		case 'codegen.emitted':
			// Engine-internal events that don't carry a projection slice
			// — surfaced on the live event stream for renderers that care,
			// but contribute no field to the subscribable state. (Adding
			// a projection field for any of these requires an architecture
			// revision per G2.)
			return withTouched({});

		case 'snapshot.captureSkipped':
		case 'snapshot.captureFailed':
		case 'snapshot.captured':
			// Terminal capture outcomes — the containers are resumed and the
			// stack is live again. Guarded clear of the transient
			// 'snapshotting' phase back to 'running': only un-stick the
			// snapshotting phase, so a stray terminal event can't yank the
			// phase out of an in-flight restart/shutdown.
			return withTouched({
				cycle:
					state.cycle.phase === 'snapshotting' ? { ...state.cycle, phase: 'running' } : state.cycle,
			});

		case 'snapshot.restored':
			// Published by the command-loop's `snapshot.restore` case AFTER
			// the destructive restore (live managed containers removed) and
			// BEFORE the follow-on full-drain re-acquire. Mark the cycle
			// 'restoring' so the dashboard reflects the in-flight restore; the
			// re-acquire then emits its own `restart.requested`/`restart.
			// completed` (→ 'restarting' → 'running') plus per-row acquiring→
			// ready transitions, which carry the rest of the restore-half
			// status updates and settle the phase back to 'running'.
			return withTouched({
				cycle: { ...state.cycle, phase: 'restoring' },
			});

		case 'shutdown.escalated':
			return withTouched({
				cycle: { ...state.cycle, phase: 'shutting-down' },
			});

		case 'error.reported':
			return withTouched({
				errors: pushBounded(state.errors, event.error, MAX_ERRORS_KEPT),
				rows: event.error.pluginKey
					? upsertRow(state.rows, event.error.pluginKey, (row) => ({
							...row,
							lastError: event.error,
						}))
					: state.rows,
			});

		case 'build.statusChanged':
			return withTouched({
				stackBuild: pushBounded(state.stackBuild, event.entry, MAX_BUILD_ENTRIES_KEPT),
			});

		case 'restart.requested':
			return withTouched({
				cycle: { ...state.cycle, phase: 'restarting' },
				rows:
					event.target === 'stack'
						? state.rows.map((r) => ({ ...r, selectiveRestartHighlight: false }))
						: state.rows.map((r) =>
								r.key === (event.target as { pluginKey: PluginKey }).pluginKey
									? { ...r, selectiveRestartHighlight: true }
									: r,
							),
			});

		case 'restart.completed':
			return withTouched({
				cycle: { ...state.cycle, phase: 'running' },
				rows: state.rows.map((r) => ({ ...r, selectiveRestartHighlight: false })),
			});

		case 'engine.orchestrator.dispatchFailed':
			// Orchestrator-side dispatch failure surfaced for renderers /
			// log consumers; carries no projection slice (the originating
			// plugin remains in its current lifecycle state — sink failure
			// is orchestrator-fault, not plugin-fault).
			return withTouched({});

		default: {
			const _exhaustive: never = event;
			void _exhaustive;
			return state;
		}
	}
};

// -----------------------------------------------------------------------------
// Engine-side mutators (not driven by EngineEvent)
// -----------------------------------------------------------------------------

/**
 * Replace `identity` on the projection. Called once at boot per cycle;
 * does NOT change on hot-restart.
 */
export const setIdentity = (
	state: SubscribableState,
	identity: SubscribableState['identity'],
): SubscribableState => ({ ...state, identity });

export const declareAccount = (
	state: SubscribableState,
	account: AccountProjection,
): SubscribableState => ({
	...state,
	accounts: upsertAccount(state.accounts, account),
});

// -----------------------------------------------------------------------------
// SubscriptionRef-driven updaters
// -----------------------------------------------------------------------------

/**
 * Apply an `EngineEvent` to the ref, bumping the sequence number
 * atomically. The seq is monotonic per process and survives cycle
 * boundaries.
 *
 * Uses `state.lastEvent.seq + 1` for monotonic per-process counts.
 *
 * Side-channel: when the event is a `projection.updated` with a
 * malformed payload, the reducer drops the slice and we emit a
 * structured warning here, inside the surrounding fiber, so it lands
 * on the fiber's structured-logging path (`Effect.logWarning`). This
 * is the only place in the reducer where a warning is emitted; the
 * pure `applyEvent` reducer never touches the logger.
 */
export const updateRef = (
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	event: EngineEvent,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		// Pre-flight: detect malformed projection-updated payloads so the
		// warning runs inside the fiber's logger context. We thread the
		// decode result into the reducer below so the hot path decodes
		// the payload exactly once per event — the previous shape ran
		// the same `Schema.decodeUnknownSync` pass twice (once here,
		// once inside `applyEvent`) on every projection.updated event.
		let prevalidated: DecodeResult<unknown> | undefined;
		if (event.tag === 'projection.updated') {
			if (event.kind === 'account' || event.kind === 'package') {
				const schema = event.kind === 'account' ? AccountProjectionSchema : PackageProjectionSchema;
				prevalidated = tryDecodeProjectionPayload(schema, event.payload);
				if (!prevalidated.ok) {
					yield* Effect.logWarning(
						`projection.updated: dropping malformed ${event.kind} payload for key=${event.key}`,
					).pipe(
						Effect.annotateLogs({
							[LogAttr.errorMessage]: formatDecodeIssue(prevalidated.cause),
						}),
					);
				}
			}
		}
		yield* SubscriptionRef.update(ref, (state) => {
			const next = applyEvent(state, event, prevalidated);
			return {
				...next,
				lastEvent: { seq: state.lastEvent.seq + 1, at: next.lastEvent.at },
			};
		});
	});

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/**
 * Sync per-kind validator for `projection.updated` payloads. Returns
 * an `ok` decode result on success or a non-`ok` one on decode
 * failure. Pure-data sync: no logger access, no `Effect.runSync` —
 * the reducer is documented as pure, and earlier versions of this
 * seam called `Effect.runSync(Effect.logWarning(...))` outside any
 * fiber context, which logged off-fiber (bypassing the supervisor's
 * structured-logging context). The Effect-aware `updateRef` wrapper
 * now emits the warning inside the fiber so the warning is captured
 * consistently with the rest of the supervisor's logs.
 *
 * On success callers still pass `event.payload` to the upsert (not the
 * decoded copy) — the runtime brand types (`account/${string}`,
 * `package/${string}`) are TS-only and the decoded copy would strip
 * them. The schema acts as a structural guard only.
 */
const tryDecodeProjectionPayload = <S extends Schema.Decoder<unknown>>(
	schema: S,
	payload: unknown,
): DecodeResult<S['Type']> => {
	try {
		return { ok: true, value: Schema.decodeUnknownSync(schema)(payload) };
	} catch (cause) {
		return { ok: false, cause };
	}
};

/**
 * Render a `Schema.decodeUnknownSync` throw into a human-readable
 * string for the warn annotation. `SchemaError` in Effect v4 stores
 * the parse issue and exposes `.message` (= `issue.toString()`); using
 * that surfaces the actual decode-issue path/expectation. Fallback to
 * `String(cause)` for non-SchemaError throws (defensive — the schema's
 * sync decoder should always throw `SchemaError`).
 */
const formatDecodeIssue = (cause: unknown): string => {
	if (Schema.isSchemaError(cause)) {
		return cause.message;
	}
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
};

const upsertRow = (
	rows: ReadonlyArray<Row>,
	key: PluginKey,
	update: (row: Row) => Row,
): ReadonlyArray<Row> => {
	const idx = rows.findIndex((r) => r.key === key);
	if (idx === -1) {
		// Row was never declared. We do NOT auto-create — declaration is
		// the plugin's job. Drop the event silently; the renderer can't
		// render a row it doesn't know about.
		return rows;
	}
	const next = rows.slice();
	next[idx] = update(rows[idx]!);
	return next;
};

const appendLogLine = (row: Row, line: string, level: 'info' | 'warn' | 'error'): Row => {
	const nextLines = [...row.logTail.lines, line];
	const truncated = nextLines.length > MAX_ROW_LOG_LINES;
	const trimmed = truncated ? nextLines.slice(-MAX_ROW_LOG_LINES) : nextLines;
	return {
		...row,
		logTail: {
			lines: trimmed,
			level: maxLevel(row.logTail.level, level),
			truncated: row.logTail.truncated || truncated,
		},
	};
};

const maxLevel = (
	a: 'info' | 'warn' | 'error',
	b: 'info' | 'warn' | 'error',
): 'info' | 'warn' | 'error' => {
	const rank = { info: 0, warn: 1, error: 2 } as const;
	return rank[a] >= rank[b] ? a : b;
};

const upsertEndpoint = (
	endpoints: ReadonlyArray<Endpoint>,
	endpoint: Endpoint,
): ReadonlyArray<Endpoint> => {
	const idx = endpoints.findIndex((e) => e.endpointKey === endpoint.endpointKey);
	if (idx === -1) return [...endpoints, endpoint];
	const next = endpoints.slice();
	next[idx] = endpoint;
	return next;
};

const upsertAccount = (
	accounts: ReadonlyArray<AccountProjection>,
	account: AccountProjection,
): ReadonlyArray<AccountProjection> => {
	const idx = accounts.findIndex((entry) => entry.key === account.key);
	if (idx === -1) return [...accounts, account];
	const next = accounts.slice();
	next[idx] = {
		...accounts[idx]!,
		...account,
		funding: {
			...accounts[idx]!.funding,
			...account.funding,
		},
	};
	return next;
};

const upsertPackage = (
	packages: ReadonlyArray<PackageProjection>,
	pkg: PackageProjection,
): ReadonlyArray<PackageProjection> => {
	const idx = packages.findIndex((entry) => entry.key === pkg.key);
	if (idx === -1) return [...packages, pkg];
	const next = packages.slice();
	next[idx] = {
		...packages[idx]!,
		...pkg,
	};
	return next;
};

const attachEndpoint = (rows: ReadonlyArray<Row>, endpoint: Endpoint): ReadonlyArray<Row> => {
	return rows.map((row) =>
		endpoint.pluginKey === row.key
			? row.endpoints.includes(endpoint.endpointKey)
				? row
				: { ...row, endpoints: [...row.endpoints, endpoint.endpointKey] }
			: row,
	);
};

const pushBounded = <T>(xs: ReadonlyArray<T>, value: T, max: number): ReadonlyArray<T> => {
	const next = [...xs, value];
	return next.length > max ? next.slice(-max) : next;
};

// Re-export referenced sub-types for downstream consumers (tests,
// renderer-side wrappers) so they don't reach into substrate/
// directly.
export type {
	AccountProjection,
	BuildEntry,
	Endpoint,
	LifecycleStatus,
	PackageProjection,
	Row,
	StructuredError,
};
