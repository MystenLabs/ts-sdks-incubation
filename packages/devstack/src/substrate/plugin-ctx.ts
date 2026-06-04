// PluginCtx — the minimal, closed, typed plugin-authoring surface.
//
// A plugin contributes to the stack through inline typed verbs it calls
// from `start`. The plugin reaches this `ctx` by `yield* PluginContext` (an Effect
// service tag, declared at the bottom of this file) — exactly like any
// other substrate service it `yield*`s (`ContainerRuntimeService`,
// `IdentityContext`, …). The supervisor PROVIDES a freshly-built
// per-plugin ctx into `start`'s requirement (R) channel via
// `Effect.provideService(start(deps), PluginContext, ctx)`. Delivering
// ctx through the requirement channel — rather than as a 2nd positional
// `start` argument — keeps `start` SINGLE-arg, which restores automatic
// contextual typing of `deps` (no per-plugin `deps:` annotations), while
// `ctx` stays always-present (the supervisor never omits it).
//
// -----------------------------------------------------------------------------
// INV-5 — the closed 8-key set
// -----------------------------------------------------------------------------
//
// `PluginCtx` has EXACTLY these 8 readonly keys and no more:
//
//   persist · codegen · endpoint · snapshotExtra · publish ·
//   provides · requires · fail
//
// This is a HARD invariant (pinned by `plugin-ctx-keyset.test-d.ts`).
// Growing the set re-builds a god-object surface. The rule for what may
// live here:
//
//   - `persist` is a thin pass-through to the Cache primitive's
//     `publish` (cache → verify → produce → register, the folded-in
//     artifact-publisher cycle). It forwards the
//     plugin-supplied HEX `spec.chain` VERBATIM — the substrate does
//     NOT fold `identity.chain` in, because the on-disk cache (and
//     warm-restart id stability) keys on the hex chain id. See B.1.
//   - `codegen` / `endpoint` / `snapshotExtra` / `publish` are the four
//     BUFFERED declarative verbs. Their backing services
//     (CodegenOrchestratorService, RouterService +
//     ManifestEndpointRegistryService, SnapshotOrchestratorService, the
//     projection sink) are SUPERVISOR-FRAME-ONLY — they are absent from
//     plugin scope. A verb call therefore cannot run its backing
//     service inline; it pushes a typed buffer entry that the supervisor
//     REPLAYS in its own frame after the plugin's `start` succeeds.
//   - `provides` / `requires` are the strategy bus (the faucet pattern
//     generalized): a plugin contributes to / reads a sibling's
//     capability-keyed registry without a dep-graph edge.
//   - `fail` is the typed plugin-fail escape hatch.
//
// What stays OUT of `ctx`, and WHY: every other substrate service a
// plugin needs is already in plugin scope and is reached with
// `yield* Service` directly — `CacheService` (whose `.publish` is the
// folded-in artifact-publisher cycle),
// `ContainerRuntimeService`, `IdentityContext`,
// `PortBrokerService`, `LeaseBrokerService`, etc. The infra
// orchestrators that are NOT in plugin scope
// (Snapshot/Codegen/Router/ManifestEndpoint) are precisely the four
// buffered verbs above — and infra contributions stay `yield*`-shaped
// declarations, NEVER imperative `ctx.tx`-style Sui leaks. Adding a
// service to `ctx` that a plugin could already `yield*` is the drift
// INV-5 forbids.

import { Context, type Effect } from 'effect';

import type { ArtifactPublisher } from '../primitives/artifact-publisher.ts';
import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { ProjectionDecl } from '../contracts/projection.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';
import type { StrategyNotFoundError } from './runtime/errors.ts';

/**
 * Type of the strategy a `ctx.requires(key)` read resolves to.
 *
 * The strategy registry stores contributions as a scope-local multimap
 * of `unknown` (see `runtime/strategy-registry/service.ts`): the
 * registered strategy's type is erased at storage, and the registry's
 * `get<Key, S>` lets the CALLER name the expected `S`. Mirroring that
 * erased read surface, `StrategyFor<K>` resolves to `unknown` for every
 * key — the reader narrows at the call site (a contributor and consumer
 * agreeing on a key's strategy shape is a plugin-pair convention the
 * substrate stays blind to). The `K` parameter is retained so the verb
 * signature reads symmetrically with `provides`/`StrategyContributorDecl`
 * and so a future typed registry can specialize this alias without
 * touching the `PluginCtx` shape.
 */
export type StrategyFor<K extends string> = Record<K, unknown>[K];

/**
 * The CLOSED union of contribution decls a plugin emits via the four
 * buffered verbs + `provides`. Discriminated by `kind`. A plugin's `start`
 * emits these inline — either by direct `ctx.*` verb calls or, for a
 * conditional/variadic set, through the shared {@link emitContributions}
 * router below. The supervisor's static dispatch switches over exactly
 * these five kinds.
 */
export type Contribution =
	| CodegenableDecl<string>
	| RoutableDecl
	| SnapshotableDecl
	| ProjectionDecl
	| StrategyContributorDecl<string, unknown>;

/**
 * The ONE shared contribution router. A plugin's `start` builds an ordered
 * (possibly conditional/variadic) list of {@link Contribution} decls and
 * feeds it here; this routes each decl to its matching `ctx` verb by its
 * `kind` discriminant, IN LIST ORDER:
 *
 *   snapshotable          → `ctx.snapshotExtra`
 *   codegenable           → `ctx.codegen`
 *   routable              → `ctx.endpoint`
 *   projection            → `ctx.publish`
 *   strategy-contributor  → `ctx.provides`
 *
 * This is the single exhaustive `switch` over the closed `Contribution`
 * union — replacing the per-plugin `build*`/`emit*` wrapper pairs that each
 * re-implemented this same routing. The supervisor mirrors this dispatch
 * when it REPLAYS the buffered decls (`acquire-node.ts`); the verbs simply
 * buffer here. For a fixed, unconditional set of decls a plugin may prefer
 * direct `ctx.*` calls — but any conditional or variadic emission should
 * route through this helper so the routing lives in exactly one place.
 *
 * Exhaustive: the `default` arm narrows `decl` to `never`, so adding a
 * sixth `Contribution` kind is a compile error here until handled.
 */
export const emitContributions = (ctx: PluginCtx, decls: ReadonlyArray<Contribution>): void => {
	for (const decl of decls) {
		switch (decl.kind) {
			case 'snapshotable':
				ctx.snapshotExtra(decl);
				break;
			case 'codegenable':
				ctx.codegen(decl);
				break;
			case 'routable':
				ctx.endpoint(decl);
				break;
			case 'projection':
				ctx.publish(decl);
				break;
			case 'strategy-contributor':
				ctx.provides(decl);
				break;
			default: {
				const _exhaustive: never = decl;
				void _exhaustive;
			}
		}
	}
};

/**
 * The minimal typed plugin-authoring context. A plugin reaches it from
 * `start` with `const ctx = yield* PluginContext` (the service tag
 * below); the supervisor provides a per-plugin instance into `start`'s
 * requirement channel.
 *
 * EXACTLY 8 keys (INV-5 — see file header). Do not add a 9th.
 */
export interface PluginCtx {
	/**
	 * Thin pass-through to the Cache primitive's `publish` (the folded-in
	 * artifact-publisher cycle). Forwards the plugin-supplied HEX
	 * `spec.chain` verbatim (NO `identity.chain` fold) so on-disk cache ids
	 * and warm-restart id stability are byte-identical to a direct
	 * `CacheService.publish`.
	 */
	readonly persist: ArtifactPublisher['publish'];
	/** Buffered: contribute a generated-file emitter to the codegen
	 *  orchestrator. Replayed in the supervisor frame after a successful
	 *  `start`. Returns void (the orchestrator owns rendering). */
	readonly codegen: <E extends string>(decl: CodegenableDecl<E>) => void;
	/** Buffered: declare a routable endpoint for the router orchestrator.
	 *  Replayed in the supervisor frame after a successful `start`.
	 *  Returns VOID — no URL is echoed back to the plugin (the router
	 *  mints and publishes the endpoint event itself). */
	readonly endpoint: (decl: RoutableDecl) => void;
	/** Buffered: declare extra snapshot subtrees / managed containers /
	 *  identity-guard hooks for the snapshot orchestrator. Replayed in
	 *  the supervisor frame after a successful `start`. */
	readonly snapshotExtra: (decl: SnapshotableDecl) => void;
	/** Buffered: publish a name-blind projection event through the
	 *  projection sink. Replayed in the supervisor frame after a
	 *  successful `start`. */
	readonly publish: (decl: ProjectionDecl) => void;
	/** Strategy bus (write): contribute a strategy under a capability
	 *  key for a sibling to read via `requires`. Registers on the
	 *  scope-local StrategyRegistry, publishes `strategy.registered`, and
	 *  arms a finalizer publishing `strategy.unregistered`. */
	readonly provides: <K extends string, S>(decl: StrategyContributorDecl<K, S>) => void;
	/** Strategy bus (read): resolve the strategy registered under a
	 *  capability key, or fail with `StrategyNotFoundError`. */
	readonly requires: <K extends string>(
		key: K,
	) => Effect.Effect<StrategyFor<K>, StrategyNotFoundError>;
	/** Typed plugin-fail escape hatch. Surfaces the tagged error through
	 *  the supervisor's `markFailed` path. */
	readonly fail: (
		error: { readonly _tag: string } & Record<string, unknown>,
	) => Effect.Effect<never>;
}

/**
 * Effect service tag carrying the per-plugin {@link PluginCtx}.
 *
 * A plugin's `start` body reaches its ctx with `const ctx = yield*
 * PluginContext`. The supervisor builds a fresh per-plugin ctx (+ its
 * replay buffer) in `runtime/supervisor/acquire-node.ts` and PROVIDES it
 * into `start`'s requirement channel
 * (`Effect.provideService(start(deps), PluginContext, ctx)`), so the tag
 * is always satisfied for code the supervisor runs.
 *
 * This ambient requirement lives only in `start`'s R-channel; it does NOT
 * surface in the public `Plugin<Id, Value, Needs>` contract (`Needs` is
 * `dependsOn` only — see `plugin.ts`). Declaring it as a service rather
 * than a `start` argument is what keeps `start` single-arg, restoring
 * automatic `deps` inference.
 */
export class PluginContext extends Context.Service<PluginContext, PluginCtx>()(
	'@devstack/substrate/PluginContext',
) {}
