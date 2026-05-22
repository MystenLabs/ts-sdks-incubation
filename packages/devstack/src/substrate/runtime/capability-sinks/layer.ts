// CapabilitySinks default layer.
//
// Composes the empty registry from `service.ts` with the substrate's
// error-contribution sink and caller-supplied capability sinks. The
// substrate does not name built-in capability contracts here; L3
// orchestrator composition owns those registrations.

import { Context, Effect, Layer, Scope } from 'effect';

import type { PluginErrorContribution } from '../../plugin.ts';
import {
	FormatterRegistryService,
	layerFormatterRegistry,
} from '../observability/formatter-registry.ts';
import {
	CapabilitySinksService,
	layerCapabilitySinks,
	type CapabilitySink,
	type ContributionKind,
} from './service.ts';

// -----------------------------------------------------------------------------
// Orchestrator-supplied capability-decl registrations
// -----------------------------------------------------------------------------

/**
 * Orchestrator-side sink registrations. The supervisor accepts these
 * at boot and registers them by `kind`; the substrate does not expose
 * one callback slot per built-in capability contract.
 */
export type OrchestratorSinks = ReadonlyArray<CapabilitySink<ContributionKind, never>>;

// -----------------------------------------------------------------------------
// Built-in sink construction
// -----------------------------------------------------------------------------

const errorContributionSink = (formatters: {
	readonly register: (c: PluginErrorContribution) => Effect.Effect<void, never, Scope.Scope>;
}): CapabilitySink<'error-contribution', PluginErrorContribution> => ({
	kind: 'error-contribution',
	accept: (contribution, _ctx) => formatters.register(contribution),
});

// -----------------------------------------------------------------------------
// Public layer factory
// -----------------------------------------------------------------------------

/**
 * Build the substrate's default CapabilitySinks layer. It supplies the
 * error-contribution sink and registers the caller's capability sinks
 * by kind. Unknown contribution kinds remain no-ops at the supervisor
 * call site unless a sink is registered.
 *
 * Plugin-author extension: provide an additional Layer that yields
 * `CapabilitySinksService` and calls `registerSink({ kind: 'my-kind', ... })`
 * before the supervisor starts harvesting. Last-write-wins on duplicate
 * kinds, with scope-bound restore — the built-in sink comes back when
 * the override's scope closes.
 */
export const layerCapabilitySinksDefault = (
	orchestrator: OrchestratorSinks = [],
): Layer.Layer<CapabilitySinksService | FormatterRegistryService, never, never> => {
	const registerDefaults = Layer.effectDiscard(
		Effect.gen(function* () {
			const sinks = yield* CapabilitySinksService;
			const fmt = yield* FormatterRegistryService;
			const defaults = [errorContributionSink(fmt), ...orchestrator];
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
