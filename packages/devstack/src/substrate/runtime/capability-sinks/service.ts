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

import { Context, Data, Effect, Layer, Ref, Scope } from 'effect';

import type { CapabilityDecl } from '../../../contracts/capability-decl.ts';
import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { PluginErrorContribution } from '../../plugin.ts';

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
	| 'strategy-contributor'
	| 'liveness-classifier'
	| 'composite-primitive'
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
}

// -----------------------------------------------------------------------------
// Sink shape
// -----------------------------------------------------------------------------

/** A sink for a specific contribution kind. `accept` is the
 *  registration body — runs on the plugin's scope so its finalizers
 *  reap on plugin teardown. */
export interface CapabilitySink<K extends ContributionKind, TDecl> {
	readonly kind: K;
	readonly accept: (decl: TDecl, ctx: HarvestContext) => Effect.Effect<void, never, Scope.Scope>;
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

// -----------------------------------------------------------------------------
// Public service shape
// -----------------------------------------------------------------------------

export interface CapabilitySinksShape {
	/** Register a sink for a contribution kind. Last-write-wins on
	 *  duplicate kinds: a plugin-author overlay replaces the built-in.
	 *  Scope-bound: registering inside a `Layer` and providing the
	 *  layer to the supervisor's scope reaps the sink on shutdown. */
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
	) => Effect.Effect<void, UnknownContributionKind, Scope.Scope>;
	/** Snapshot the kinds the registry currently knows. Diagnostic. */
	readonly knownKinds: Effect.Effect<ReadonlyArray<string>>;
}

export class CapabilitySinksService extends Context.Service<
	CapabilitySinksService,
	CapabilitySinksShape
>()('@devstack-rewrite/substrate/CapabilitySinks') {}

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

type SinkAccept = (decl: unknown, ctx: HarvestContext) => Effect.Effect<void, never, Scope.Scope>;

/** Layer constructing an empty registry. Built-in sinks ship via the
 *  composed `layerCapabilitySinksDefault` (see `layer.ts`); plugin-
 *  authored sinks compose by providing a Layer that yields the
 *  service and calls `registerSink`. */
export const layerCapabilitySinks: Layer.Layer<CapabilitySinksService> = Layer.effect(
	CapabilitySinksService,
	Effect.gen(function* () {
		const sinksRef = yield* Ref.make<ReadonlyMap<string, SinkAccept>>(new Map());

		const registerSink = <K extends ContributionKind, TDecl>(
			sink: CapabilitySink<K, TDecl>,
		): Effect.Effect<void, never, Scope.Scope> =>
			Effect.gen(function* () {
				const accept = sink.accept as SinkAccept;
				const prior = yield* Ref.modify(sinksRef, (current) => {
					const next = new Map(current);
					const had = next.get(sink.kind) ?? null;
					next.set(sink.kind, accept);
					return [had, next];
				});
				// Scope finalizer: restore the prior sink (or remove
				// entirely) on scope close. Symmetric semantics — a
				// plugin-author overlay's scope close restores the
				// built-in.
				yield* Effect.addFinalizer((_exit) =>
					Ref.update(sinksRef, (current) => {
						const next = new Map(current);
						if (prior === null) next.delete(sink.kind);
						else next.set(sink.kind, prior);
						return next;
					}),
				);
				yield* Effect.annotateCurrentSpan({
					'capability-sinks.kind': sink.kind,
				});
			}).pipe(Effect.withSpan('substrate.capabilitySinks.registerSink'));

		const dispatch = (
			contribution: AnyContribution,
			ctx: HarvestContext,
		): Effect.Effect<void, UnknownContributionKind, Scope.Scope> =>
			Effect.gen(function* () {
				const kind = kindOf(contribution);
				const sinks = yield* Ref.get(sinksRef);
				const accept = sinks.get(kind);
				if (accept === undefined) {
					return yield* new UnknownContributionKind({
						kind,
						known: [...sinks.keys()],
					});
				}
				const payload: unknown =
					contribution.source === 'error' ? contribution.contribution : contribution.decl;
				yield* accept(payload, ctx);
				yield* Effect.annotateCurrentSpan({
					'capability-sinks.kind': kind,
					'devstack.plugin': ctx.pluginKey,
				});
			}).pipe(Effect.withSpan('substrate.capabilitySinks.dispatch'));

		const knownKinds: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
			const sinks = yield* Ref.get(sinksRef);
			return [...sinks.keys()];
		});

		return CapabilitySinksService.of({ registerSink, dispatch, knownKinds });
	}),
);
