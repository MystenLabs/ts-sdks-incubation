// Supervisor capability-dispatch path.
//
// Walks a plugin's `capabilities` tuple + `errorContributions` after a
// successful acquire and routes each item through the substrate-owned
// `CapabilitySinksService`.
//
// Bug-fix history (backlog #39): the original implementation only
// caught `UnknownContributionKind` from `sinks.dispatch()`. The error
// channel also yields `ContributionSinkFailed` (a registered sink
// rejected while handling a known kind — router/codegen collisions,
// upstream IO faults). The wrapping `Effect.exit` at the acquire-node
// callsite then projected the failure through `registry.markFailed`,
// attributing the orchestrator's bug to the plugin.
//
// Fix: catch BOTH tags here and route them DIFFERENTLY.
//   - `UnknownContributionKind` → no-op (substrate-open-by-default;
//     the plugin emitted a contribution shape no sink claims).
//   - `ContributionSinkFailed` → publish the typed
//     `engine.orchestrator.dispatchFailed` event + log a warning; the
//     plugin stays ready.

import { Context, Effect, Queue, Scope, SubscriptionRef } from 'effect';

import type { CapabilityDecl } from '../../../contracts/capability-decl.ts';
import type { StrategyContributorDecl } from '../../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../../brand.ts';
import type { EngineEvent } from '../../events.ts';
import type { Identity } from '../../identity.ts';
import type { PluginRole } from '../../lifecycle.ts';
import type { AcquireContext, PluginErrorContribution } from '../../plugin.ts';
import type { SubscribableState } from '../../projection.ts';
import {
	type AnyContribution,
	type CapabilitySinksShape,
	type HarvestContext,
} from '../capability-sinks/index.ts';
import { withPluginSpan } from '../observability/index.ts';
import { StrategyRegistryService } from '../strategy-registry/service.ts';
import { CapabilityFactoryFailed } from './errors.ts';
import { noopStrategyRegistry, OptionalService, publish } from './wiring.ts';

const strategyRegistryAccess = OptionalService(StrategyRegistryService);

/**
 * Resolve a plugin's `capabilities` field to a concrete decl tuple.
 *
 * Two accepted shapes (see `Plugin.capabilities` for the
 * authoring-side contract):
 *
 *   (a) Static — a plain `ReadonlyArray<CapabilityDecl>`. Returned
 *       as-is.
 *
 *   (b) Dynamic — a `CapabilitiesFactory<…>` function. Invoked with
 *       the resolved plugin value + the acquire context built from
 *       the supervisor's identity + runtime root. The function is
 *       called once per acquire (post-success); the returned tuple
 *       flows into `dispatchContributions` like a static one.
 *
 * The dynamic seam exists so plugins' snapshot subtrees, codegen
 * bindings, routable URLs, strategy contributions, etc. can stamp
 * the REAL chain id / package id / network alias produced by their
 * acquire body, instead of the factory-time placeholder strings the
 * static form forces.
 *
 * The substrate stays generic: this resolver doesn't know any
 * service name; the discrimination is purely structural
 * (`typeof === 'function'`).
 */
export const resolveCapabilities = (
	pluginKey: PluginKey,
	field:
		| ReadonlyArray<CapabilityDecl>
		| ((resolved: unknown, ctx: AcquireContext) => ReadonlyArray<CapabilityDecl>)
		| undefined,
	resolved: unknown,
	acquireContext: AcquireContext,
): Effect.Effect<ReadonlyArray<CapabilityDecl>, CapabilityFactoryFailed> => {
	if (field === undefined) return Effect.succeed([]);
	if (typeof field === 'function') {
		return Effect.try({
			try: () => field(resolved, acquireContext),
			catch: (cause) =>
				new CapabilityFactoryFailed({
					pluginKey,
					message: `capability factory failed for ${pluginKey}`,
					cause,
				}),
		});
	}
	return Effect.succeed(field);
};

/**
 * Walk a plugin's `capabilities` tuple + `errorContributions` after a
 * successful acquire, route every contribution through the
 * substrate-owned `CapabilitySinksService`. The plugin's scope is
 * provided so each sink's `addFinalizer` lands on the plugin's scope —
 * registrations reap on selective-restart / shutdown.
 *
 * The supervisor stays kind-blind: it builds the contribution union
 * (`{source: 'capability'|'error', ...}`) and the dispatch happens
 * inside the service. Unknown kinds are downgraded to no-ops here so
 * the substrate-open-by-default contract holds — plugin authors can
 * emit a custom-kind decl that is observed only by the orchestrators
 * that registered the matching sink.
 *
 * Sink failures (`ContributionSinkFailed`) are routed through a
 * separate `engine.orchestrator.dispatchFailed` event so the plugin
 * remains ready and the orchestrator's broken sink is the visible
 * fault (backlog #39).
 */
export const dispatchContributions = (
	pluginKey: PluginKey,
	capabilities: ReadonlyArray<CapabilityDecl>,
	errorContributions: ReadonlyArray<PluginErrorContribution>,
	pluginRole: PluginRole,
	identity: Identity,
	pluginContext: Context.Context<never>,
	pluginScope: Scope.Scope,
	sinks: CapabilitySinksShape,
	ref: SubscriptionRef.SubscriptionRef<SubscribableState>,
	hub: Queue.Enqueue<EngineEvent>,
): Effect.Effect<void, unknown, never> =>
	Effect.gen(function* () {
		const strategyRegistry = strategyRegistryAccess.read(pluginContext, noopStrategyRegistry);
		const harvestCtx: HarvestContext = {
			pluginKey,
			identity,
			publish: (event) => publish(ref, hub, event),
			registerStrategy: (decl: StrategyContributorDecl<string, unknown>) =>
				strategyRegistry.register(decl.capabilityKey, decl.strategy, {
					autoMounted: decl.autoMounted,
					...(decl.priority === undefined ? {} : { priority: decl.priority }),
				}),
		};

		const items: ReadonlyArray<AnyContribution> = [
			...capabilities.map<AnyContribution>((decl) => ({
				source: 'capability',
				decl,
			})),
			...errorContributions.map<AnyContribution>((contribution) => ({
				source: 'error',
				contribution,
			})),
		];

		for (const item of items) {
			const dispatch = sinks.dispatch(item, harvestCtx).pipe(
				Effect.catchTags({
					UnknownContributionKind: () => Effect.void,
					ContributionSinkFailed: (err) =>
						Effect.gen(function* () {
							// Orchestrator-fault path: surface the typed event so
							// renderers + log consumers see WHICH sink failed
							// without misattributing to the plugin. The plugin's
							// lifecycle state is untouched; the markFailed path
							// in `acquireNode` is NOT taken for this branch.
							yield* publish(ref, hub, {
								tag: 'engine.orchestrator.dispatchFailed',
								pluginKey,
								kind: err.kind,
								message: err.message,
								at: Date.now(),
							});
							yield* Effect.logWarning(
								`capability sink '${err.kind}' failed for plugin '${pluginKey}'`,
							);
						}),
				}),
			);
			yield* Scope.provide(dispatch, pluginScope);
		}
	}).pipe(
		withPluginSpan('lifecycle.supervisor.dispatchContributions', {
			app: identity.app,
			stack: identity.stack,
			network: identity.chain,
			pluginKey,
			role: pluginRole,
		}),
	);
