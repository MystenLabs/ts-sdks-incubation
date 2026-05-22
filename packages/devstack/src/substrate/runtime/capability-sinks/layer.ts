// Built-in CapabilitySinks layer.
//
// Composes the empty registry from `service.ts` with the substrate's
// default sinks. The error-contribution sink wires PluginErrorContribution
// into the FormatterRegistry; the capability-decl sinks are stubs that
// delegate to the user-supplied `OrchestratorSinks` bag the supervisor
// hands in at boot. L3 orchestrators install their real sinks by
// providing this Layer downstream of their registration.
//
// Naming discipline: the substrate ships a sink for every built-in
// `kind` literal but the sink BODIES name no plugin. The
// orchestrator-supplied callbacks land at the supervisor boundary,
// not inside the substrate.

import { Context, Effect, Layer, Scope } from 'effect';

import type { CodegenableDecl } from '../../../contracts/codegenable.ts';
import type { LivenessClassifierDecl } from '../../../contracts/liveness-classifier.ts';
import type { ProjectionDecl } from '../../../contracts/projection.ts';
import type { RoutableDecl } from '../../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../../brand.ts';
import type { PluginErrorContribution } from '../../plugin.ts';
import {
	FormatterRegistryService,
	layerFormatterRegistry,
} from '../observability/formatter-registry.ts';
import {
	CapabilitySinksService,
	layerCapabilitySinks,
	type CapabilitySink,
	type HarvestContext,
} from './service.ts';

// -----------------------------------------------------------------------------
// Orchestrator-supplied capability-decl handlers
// -----------------------------------------------------------------------------

/**
 * Orchestrator-side registration callbacks. The supervisor accepts
 * one of these at boot; the built-in capability-sinks layer routes
 * each harvested decl to the matching callback. Substrate stays
 * name-blind: the orchestrator's callbacks land here once, and the
 * substrate iterates `decl.kind` without naming any service.
 *
 * Every slot is optional — tests + bare `supervise()` call sites
 * leave most undefined and only override what they need.
 */
export interface OrchestratorSinks {
	readonly snapshotable?: (
		pluginKey: PluginKey,
		decl: SnapshotableDecl,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly routable?: (
		pluginKey: PluginKey,
		decl: RoutableDecl,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly codegenable?: (
		pluginKey: PluginKey,
		decl: CodegenableDecl<string>,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly projection?: (
		pluginKey: PluginKey,
		decl: ProjectionDecl,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly strategy?: (
		pluginKey: PluginKey,
		decl: StrategyContributorDecl<string, unknown>,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly liveness?: (
		pluginKey: PluginKey,
		decl: LivenessClassifierDecl,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
}

// -----------------------------------------------------------------------------
// Built-in sink construction
// -----------------------------------------------------------------------------

/** Build the default sinks from the orchestrator bag + the
 *  formatter-registry service. Each sink is a one-liner that adapts
 *  the substrate-typed payload to the orchestrator's callback signature
 *  (or the formatter registry, in the error-contribution case). */
const buildDefaultSinks = (
	orchestrator: OrchestratorSinks,
	formatters: {
		readonly register: (c: PluginErrorContribution) => Effect.Effect<void, never, Scope.Scope>;
	},
): ReadonlyArray<CapabilitySink<string, never>> => {
	const sinks: Array<CapabilitySink<string, never>> = [];
	const push = <K extends string, TDecl>(sink: CapabilitySink<K, TDecl>): void => {
		sinks.push(sink as unknown as CapabilitySink<string, never>);
	};

	push<'snapshotable', SnapshotableDecl>({
		kind: 'snapshotable',
		accept: (decl, ctx) =>
			orchestrator.snapshotable ? orchestrator.snapshotable(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'routable', RoutableDecl>({
		kind: 'routable',
		accept: (decl, ctx) =>
			orchestrator.routable ? orchestrator.routable(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'codegenable', CodegenableDecl<string>>({
		kind: 'codegenable',
		accept: (decl, ctx) =>
			orchestrator.codegenable ? orchestrator.codegenable(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'projection', ProjectionDecl>({
		kind: 'projection',
		accept: (decl, ctx) =>
			Effect.gen(function* () {
				const event =
					decl.event.tag === 'account.updated'
						? {
								...decl.event,
								account: {
									...decl.event.account,
									rowKey: decl.event.account.rowKey ?? ctx.pluginKey,
								},
							}
						: {
								...decl.event,
								package: {
									...decl.event.package,
									rowKey: decl.event.package.rowKey ?? ctx.pluginKey,
								},
							};
				yield* ctx.publish(event);
				if (orchestrator.projection) {
					yield* orchestrator.projection(ctx.pluginKey, decl, ctx);
				}
			}),
	});

	push<'strategy-contributor', StrategyContributorDecl<string, unknown>>({
		kind: 'strategy-contributor',
		accept: (decl, ctx) =>
			Effect.gen(function* () {
				yield* ctx.registerStrategy(decl);
				const at = Date.now();
				yield* ctx.publish({
					tag: 'strategy.registered',
					capabilityKey: decl.capabilityKey,
					autoMounted: decl.autoMounted,
					at,
				});
				yield* Effect.addFinalizer(() =>
					ctx.publish({
						tag: 'strategy.unregistered',
						capabilityKey: decl.capabilityKey,
						at: Date.now(),
					}),
				);
				if (orchestrator.strategy) {
					yield* orchestrator.strategy(ctx.pluginKey, decl, ctx);
				}
			}),
	});

	push<'liveness-classifier', LivenessClassifierDecl>({
		kind: 'liveness-classifier',
		accept: (decl, ctx) =>
			orchestrator.liveness ? orchestrator.liveness(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'error-contribution', PluginErrorContribution>({
		kind: 'error-contribution',
		accept: (contribution, _ctx) => formatters.register(contribution),
	});

	return sinks;
};

// -----------------------------------------------------------------------------
// Public layer factory
// -----------------------------------------------------------------------------

/**
 * Build the substrate's default CapabilitySinks layer. Supplies sinks
 * for the six built-in capability kinds + `error-contribution`, all
 * routed through the orchestrator's optional callback bag and the
 * formatter-registry service.
 *
 * Plugin-author extension: provide an additional Layer that yields
 * `CapabilitySinksService` and calls `registerSink({ kind: 'my-kind', ... })`
 * before the supervisor starts harvesting. Last-write-wins on duplicate
 * kinds, with scope-bound restore — the built-in sink comes back when
 * the override's scope closes.
 */
export const layerCapabilitySinksDefault = (
	orchestrator: OrchestratorSinks,
): Layer.Layer<CapabilitySinksService | FormatterRegistryService, never, never> => {
	const registerDefaults = Layer.effectDiscard(
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const fmt = yield* FormatterRegistryService;
			const defaults = buildDefaultSinks(orchestrator, fmt);
			for (const sink of defaults) {
				yield* sinks.registerSink(sink);
			}
		}),
	);
	return registerDefaults.pipe(
		Layer.provideMerge(layerCapabilitySinks),
		Layer.provideMerge(layerFormatterRegistry),
	);
};

/** Re-exposed dependency: callers that want the formatter registry
 *  available downstream (e.g. CLI / TUI / cascade-formatter consumers)
 *  pull it from the default layer. */
export type CapabilitySinksRequirements = Context.Context<
	CapabilitySinksService | FormatterRegistryService
>;
