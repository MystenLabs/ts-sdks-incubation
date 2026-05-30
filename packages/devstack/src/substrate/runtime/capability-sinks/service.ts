// CapabilitySinks — kind→sink registry.
//
// Architecture § Substrate name-blindness (STYLE_GUIDE Open slot O6):
// the supervisor used to import a hardcoded list of capability-decl
// modules and dispatch by name on a switch. This module inverts that:
// the substrate exposes an Effect.Service the supervisor consults
// once per harvested contribution; plugin-authored kinds can be
// registered via the same surface that ships the built-ins. Adding a
// new capability contract is `registerSink({ kind, accept })` — no
// supervisor edit required.
//
// The dispatch is structural on the `kind` literal of the contribution.
// The substrate never inspects the contribution's payload; the sink's
// `accept` body owns interpretation. The substrate never imports a
// concrete plugin module.

import { Context, Data, Effect, Layer, Scope } from 'effect';

import type { CapabilityDecl } from '../../../contracts/capability-decl.ts';
import type { StrategyContributorDecl } from '../../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { PluginErrorContribution } from '../../plugin.ts';
import { SpanAttr } from '../observability/spans.ts';
import { makeScopedMultimap } from '../scoped-multimap/index.ts';

// -----------------------------------------------------------------------------
// Contribution surface
// -----------------------------------------------------------------------------

/** A single harvested item — either a capability decl OR an error
 *  contribution. Discriminated by the literal `kind`. The supervisor
 *  produces one of these for each item it pulls off a plugin during
 *  the harvest loop. */
export type AnyContribution =
	| { readonly source: 'capability'; readonly decl: CapabilityDecl }
	| { readonly source: 'error'; readonly contribution: PluginErrorContribution };

/** The discriminator the sinks register against. Substrate-owned
 *  literal vocabulary — plugins authoring a custom contract add a new
 *  literal and a sink. */
export type ContributionKind =
	| 'snapshotable'
	| 'routable'
	| 'codegenable'
	| 'projection'
	| 'strategy-contributor'
	| 'error-contribution'
	| (string & { readonly __extensionKind?: never });

// -----------------------------------------------------------------------------
// Harvest context
// -----------------------------------------------------------------------------

/** Context the harvest loop supplies to each sink invocation. Carries
 *  the plugin's key + identity so sinks can attribute their work
 *  without naming the plugin. `publish` is the supervisor-owned event
 *  path, so sink-emitted events keep the same ordering/projection
 *  semantics as lifecycle/log/error events. The plugin scope is
 *  exposed via `Scope.Scope` in the sink's R-channel — sinks
 *  `addFinalizer` lands on the plugin's scope so registrations reap
 *  on plugin teardown. */
export interface HarvestContext {
	readonly pluginKey: PluginKey;
	readonly identity: Identity;
	readonly publish: (event: EngineEvent) => Effect.Effect<void, never, never>;
	readonly registerStrategy: (
		decl: StrategyContributorDecl<string, unknown>,
	) => Effect.Effect<void, never, Scope.Scope>;
}

// -----------------------------------------------------------------------------
// Sink shape
// -----------------------------------------------------------------------------

/** A sink for a specific contribution kind. `accept` is the
 *  registration body — runs on the plugin's scope so its finalizers
 *  reap on plugin teardown. */
export interface CapabilitySink<K extends ContributionKind, TDecl> {
	readonly kind: K;
	readonly accept: (decl: TDecl, ctx: HarvestContext) => Effect.Effect<void, unknown, Scope.Scope>;
}

// -----------------------------------------------------------------------------
// Dispatch errors
// -----------------------------------------------------------------------------

/** Surfaced when `dispatch` receives a kind no sink is registered for.
 *  Substrate stays open by default — unknown kinds are no-ops at the
 *  supervisor's call site (see `dispatchOrIgnore`); but tests + custom
 *  callers can drive the strict surface via `dispatch`. */
export class UnknownContributionKind extends Data.TaggedError('UnknownContributionKind')<{
	readonly kind: string;
	readonly known: ReadonlyArray<string>;
}> {}

/** Surfaced when a registered sink rejects while handling a known
 *  contribution kind. The original failure stays attached as `cause`
 *  so the supervisor's structured error renderer shows the domain
 *  error, such as `RouteCollision`, underneath the dispatch wrapper. */
export class ContributionSinkFailed extends Data.TaggedError('ContributionSinkFailed')<{
	readonly kind: string;
	readonly message: string;
	readonly cause: unknown;
}> {}

// -----------------------------------------------------------------------------
// Public service shape
// -----------------------------------------------------------------------------

export interface CapabilitySinksShape {
	/** Register a sink for a contribution kind. Last-write-wins on
	 *  duplicate kinds: a plugin-author overlay shadows the built-in
	 *  (the highest-seq surviving registration wins at `dispatch`).
	 *  Scope-bound: registering inside a `Layer` and providing the
	 *  layer to the supervisor's scope reaps the sink on shutdown.
	 *  Closing an overlay's scope un-shadows the built-in WITHOUT
	 *  clobbering any newer sibling registration for the same kind —
	 *  the scoped-multimap drops only this registration's own entry. */
	readonly registerSink: <K extends ContributionKind, TDecl>(
		sink: CapabilitySink<K, TDecl>,
	) => Effect.Effect<void, never, Scope.Scope>;
	/** Dispatch a contribution to its registered sink. Errors with
	 *  `UnknownContributionKind` when no sink matches; the supervisor's
	 *  loop catches and downgrades to a no-op (per the
	 *  substrate-open-by-default rule). */
	readonly dispatch: (
		contribution: AnyContribution,
		ctx: HarvestContext,
	) => Effect.Effect<void, UnknownContributionKind | ContributionSinkFailed, Scope.Scope>;
	/** Snapshot the kinds the registry currently knows. Diagnostic. */
	readonly knownKinds: Effect.Effect<ReadonlyArray<string>>;
}

export class CapabilitySinksService extends Context.Service<
	CapabilitySinksService,
	CapabilitySinksShape
>()('@devstack/substrate/CapabilitySinks') {}

// -----------------------------------------------------------------------------
// Implementation helper — kind extraction
// -----------------------------------------------------------------------------

/** Derive the discriminator literal from a harvested contribution.
 *  Substrate name-blindness: this is the ONE place the substrate
 *  reads a `kind` off a decl — every other site routes through the
 *  registered sink, which interprets the payload. */
export const kindOf = (contribution: AnyContribution): ContributionKind => {
	if (contribution.source === 'error') return 'error-contribution';
	// `decl.kind` is a literal on every CapabilityDecl variant; we
	// trust the substrate-owned contract here.
	return contribution.decl.kind;
};

// -----------------------------------------------------------------------------
// Layer
// -----------------------------------------------------------------------------

type SinkAccept = (decl: unknown, ctx: HarvestContext) => Effect.Effect<void, unknown, Scope.Scope>;

/** Layer constructing an empty registry. Built-in sinks ship via the
 *  composed `layerCapabilitySinksDefault` (see `layer.ts`); plugin-
 *  authored sinks compose by providing a Layer that yields the
 *  service and calls `registerSink`. */
export const layerCapabilitySinks: Layer.Layer<CapabilitySinksService> = Layer.effect(
	CapabilitySinksService,
	Effect.gen(function* () {
		// Seq-tagged multimap, NOT a single-value-per-kind map. The old
		// shape stored one accept per kind and restored a captured
		// `prior` on scope close — correct only under strict LIFO. With
		// sibling scopes (an overlay registered while another overlay for
		// the same kind is still live) the first to close would restore
		// ITS stale `prior` and clobber the live sibling. The multimap's
		// drop-by-seq finalizer removes only this registration's entry,
		// so the surviving highest-seq sink keeps winning regardless of
		// close order.
		const store = yield* makeScopedMultimap<string, SinkAccept>();

		const registerSink = <K extends ContributionKind, TDecl>(
			sink: CapabilitySink<K, TDecl>,
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const accept = sink.accept as SinkAccept;
				// The multimap's register is already uninterruptible and
				// wires the drop-by-seq finalizer atomically with the
				// append (mirrors `leaseBroker.tryAcquire`).
				yield* store.register([{ key: sink.kind, value: accept }]);
				yield* Effect.annotateCurrentSpan({
					[SpanAttr.capabilitySinksKind]: sink.kind,
				});
			}).pipe(Effect.withSpan('substrate.capabilitySinks.registerSink'));

		const dispatch = (
			contribution: AnyContribution,
			ctx: HarvestContext,
		): Effect.Effect<void, UnknownContributionKind | ContributionSinkFailed, Scope.Scope> =>
			Effect.gen(function* () {
				const kind = kindOf(contribution);
				const entries = yield* store.entriesFor(kind);
				if (entries.length === 0) {
					const known = yield* store.keys;
					return yield* new UnknownContributionKind({ kind, known });
				}
				// Last-write-wins: the highest-seq surviving registration
				// is the active sink for this kind.
				let chosen = entries[0]!;
				for (let i = 1; i < entries.length; i++) {
					if (entries[i]!.seq > chosen.seq) chosen = entries[i]!;
				}
				const accept = chosen.value;
				const payload: unknown =
					contribution.source === 'error' ? contribution.contribution : contribution.decl;
				yield* accept(payload, ctx).pipe(
					Effect.mapError(
						(cause) =>
							new ContributionSinkFailed({
								kind,
								message: `capability sink '${kind}' failed`,
								cause,
							}),
					),
				);
				yield* Effect.annotateCurrentSpan({
					[SpanAttr.capabilitySinksKind]: kind,
					[SpanAttr.plugin]: ctx.pluginKey,
				});
			}).pipe(Effect.withSpan('substrate.capabilitySinks.dispatch'));

		const knownKinds: Effect.Effect<ReadonlyArray<string>> = store.keys;

		return CapabilitySinksService.of({ registerSink, dispatch, knownKinds });
	}),
);
