// ContributionDispatcher — the closed, typed post-start contribution seam.
//
// Stage B (plugin API inversion, P4) replaced the open kind→sink
// registry (`CapabilitySinks`) with a CLOSED set of five typed
// dispatch methods, one per built-in contribution kind. The supervisor
// reads the buffered ctx contributions after a successful `start` and
// calls the matching method directly (an exhaustive switch on the decl
// discriminant — no string-kind matching, no UnknownContributionKind
// arm).
//
// Substrate name-blindness (ARCHITECTURE.md §"Substrate name-blindness"):
// each method's BODY lives in L3 orchestrator composition
// (`orchestrators/boot.ts buildProductionContributionDispatcher`),
// where the backing orchestrator services (Snapshot/Codegen/Router/
// ManifestEndpoint) are in scope. The supervisor only holds this opaque
// record of effects — it never imports an orchestrator service and never
// names a concrete contract beyond the five substrate-owned decl shapes.
//
// The four buffered verbs' backing services are SUPERVISOR-FRAME-ONLY
// (absent from plugin scope), which is exactly why they are buffered and
// replayed here rather than run inline in the plugin's `start`.

import { Effect, type Scope } from 'effect';

import type { ProjectionDecl } from '../../../contracts/projection.ts';
import type { RoutableDecl } from '../../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../../contracts/strategy-contributor.ts';
import type { CodegenableDecl } from '../../../contracts/codegenable.ts';
import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { StrategyRegistry } from '../../../contracts/strategy-contributor.ts';

/**
 * Per-plugin context the dispatcher methods receive. Carries the
 * plugin's key + the supervisor-owned `publish` (so dispatcher-emitted
 * events keep lifecycle/log/error ordering) + the scope-local
 * StrategyRegistry the `strategyContributor` body registers against.
 *
 * The dispatcher methods run on the plugin's scope (the supervisor
 * `Scope.provide`s it), so any `addFinalizer` they arm reaps on plugin
 * teardown (selective-restart / shutdown).
 */
export interface ContributionDispatchContext {
	readonly pluginKey: PluginKey;
	readonly publish: (event: EngineEvent) => Effect.Effect<void, never, never>;
	readonly strategyRegistry: StrategyRegistry;
}

/**
 * The closed, typed contribution-dispatch seam. EXACTLY five methods —
 * one per built-in contribution kind. Each `accept*` body is an effect
 * that may FAIL (`unknown` error channel): a failure is the
 * orchestrator-fault path (a broken sink, e.g. a router-route
 * collision), surfaced by the supervisor as
 * `engine.orchestrator.dispatchFailed` WITHOUT marking the plugin
 * failed — matching the legacy dual-catch semantics.
 *
 * The bodies live in L3 (`buildProductionContributionDispatcher`); the
 * supervisor holds this record opaquely.
 */
export interface ContributionDispatcher {
	readonly snapshotable: (
		decl: SnapshotableDecl,
		ctx: ContributionDispatchContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly routable: (
		decl: RoutableDecl,
		ctx: ContributionDispatchContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly codegenable: (
		decl: CodegenableDecl<string>,
		ctx: ContributionDispatchContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly projection: (
		decl: ProjectionDecl,
		ctx: ContributionDispatchContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly strategyContributor: (
		decl: StrategyContributorDecl<string, unknown>,
		ctx: ContributionDispatchContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
}

/** A dispatcher whose methods are all no-ops. Used by bare smoke-test
 *  `supervise()` paths that layer no orchestrators — the buffered
 *  contributions simply have nowhere to go (matching the old empty
 *  `OrchestratorSinks` default). */
export const noopContributionDispatcher: ContributionDispatcher = {
	snapshotable: () => Effect.void,
	routable: () => Effect.void,
	codegenable: () => Effect.void,
	projection: () => Effect.void,
	strategyContributor: () => Effect.void,
};
