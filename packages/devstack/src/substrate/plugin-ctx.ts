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
// INV-5 — the closed 5-key set
// -----------------------------------------------------------------------------
//
// `PluginCtx` has EXACTLY these 5 readonly keys and no more:
//
//   codegen · endpoint · snapshotExtra · publish · provides
//
// This is a HARD invariant (pinned by `plugin-ctx-keyset.test-d.ts`).
// Growing the set re-builds a god-object surface. The rule for what may
// live here:
//
//   - `codegen` / `endpoint` / `snapshotExtra` / `publish` are the four
//     BUFFERED declarative verbs. Their backing services
//     (CodegenOrchestratorService, RouterService +
//     ManifestEndpointRegistryService, SnapshotOrchestratorService, the
//     projection sink) are SUPERVISOR-FRAME-ONLY — they are absent from
//     plugin scope. A verb call therefore cannot run its backing
//     service inline; it pushes a typed buffer entry that the supervisor
//     REPLAYS in its own frame after the plugin's `start` succeeds.
//   - `provides` is the strategy bus writer (the faucet pattern
//     generalized): a plugin contributes to a sibling's
//     capability-keyed registry without a dep-graph edge. Siblings READ
//     it with `yield* StrategyRegistryService` directly (no ctx verb).
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

import { Context } from 'effect';

import type { CodegenableDecl } from '../contracts/codegenable.ts';
import type { ProjectionDecl } from '../contracts/projection.ts';
import type { RoutableDecl } from '../contracts/routable.ts';
import type { SnapshotableDecl } from '../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../contracts/strategy-contributor.ts';

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
 * EXACTLY 5 keys (INV-5 — see file header). Do not add a 6th.
 */
export interface PluginCtx {
	/** Buffered: contribute the plugin's LIVE codegen decl to the codegen
	 *  orchestrator. Replayed in the supervisor frame after a successful
	 *  `start` (it carries post-acquire runtime state — resolved ids, rpc —
	 *  so it cannot be a static spec field; that is exactly why it is a
	 *  buffered verb). Since codegen was decoupled from boot this is the
	 *  LIVE half ONLY: at boot the orchestrator projects the decl into the
	 *  loadable deployment (`assembleDeployment`) and, for dev-only decls,
	 *  writes the `generated-extras` tree (`emitExtras`) — it does NOT write
	 *  the committed `src/generated` tree. That committed, stack-free tree is
	 *  emitted separately by the `devstack codegen` verb from the plugin
	 *  spec's `staticCodegen` hook, derived from the SAME `ConfigBindingSet`.
	 *  Returns void (the orchestrator owns rendering). */
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
	 *  key for a sibling to read via `StrategyRegistryService`. Registers
	 *  on the scope-local StrategyRegistry, publishes `strategy.registered`,
	 *  and arms a finalizer publishing `strategy.unregistered`. */
	readonly provides: <K extends string, S>(decl: StrategyContributorDecl<K, S>) => void;
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
