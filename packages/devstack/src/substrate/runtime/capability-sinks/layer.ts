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
import type { CompositePrimitiveDecl } from '../../../contracts/composite-primitive.ts';
import type { LifenessClassifierDecl } from '../../../contracts/liveness-classifier.ts';
import type { RoutableDecl } from '../../../contracts/routable.ts';
import type { SnapshotableDecl } from '../../../contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../../contracts/strategy-contributor.ts';
import type { PluginKey } from '../../brand.ts';
import type { AccountProjection, PackageProjection } from '../../projection.ts';
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
		decl: CodegenableDecl<unknown, string>,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly strategy?: (
		pluginKey: PluginKey,
		decl: StrategyContributorDecl<string, unknown>,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly liveness?: (
		pluginKey: PluginKey,
		decl: LifenessClassifierDecl,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
	readonly composite?: (
		pluginKey: PluginKey,
		decl: CompositePrimitiveDecl,
		ctx: HarvestContext,
	) => Effect.Effect<void, unknown, Scope.Scope>;
}

// -----------------------------------------------------------------------------
// Built-in sink construction
// -----------------------------------------------------------------------------

/** Build the seven default sinks from the orchestrator bag + the
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

	push<'codegenable', CodegenableDecl<unknown, string>>({
		kind: 'codegenable',
		accept: (decl, ctx) =>
			orchestrator.codegenable ? orchestrator.codegenable(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'strategy-contributor', StrategyContributorDecl<string, unknown>>({
		kind: 'strategy-contributor',
		accept: (decl, ctx) =>
			Effect.gen(function* () {
				const account = accountProjectionFromStrategy(decl, ctx.pluginKey);
				if (account !== null) {
					yield* ctx.publish({
						tag: 'account.updated',
						account,
						at: account.updatedAt,
					});
				}
				const pkg = packageProjectionFromStrategy(decl, ctx.pluginKey);
				if (pkg !== null) {
					yield* ctx.publish({
						tag: 'package.updated',
						package: pkg,
						at: pkg.updatedAt,
					});
				}
				if (orchestrator.strategy) {
					yield* orchestrator.strategy(ctx.pluginKey, decl, ctx);
				}
			}),
	});

	push<'liveness-classifier', LifenessClassifierDecl>({
		kind: 'liveness-classifier',
		accept: (decl, ctx) =>
			orchestrator.liveness ? orchestrator.liveness(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'composite-primitive', CompositePrimitiveDecl>({
		kind: 'composite-primitive',
		// Composite roll-up is owned by the dep-graph's
		// `compositeParent` link — no orchestrator registration here.
		// Sink still exists so `dispatch` doesn't fail on composite
		// decls; orchestrators wanting to observe composites override.
		accept: (decl, ctx) =>
			orchestrator.composite ? orchestrator.composite(ctx.pluginKey, decl, ctx) : Effect.void,
	});

	push<'error-contribution', PluginErrorContribution>({
		kind: 'error-contribution',
		accept: (contribution, _ctx) => formatters.register(contribution),
	});

	return sinks;
};

const accountProjectionFromStrategy = (
	decl: StrategyContributorDecl<string, unknown>,
	rowKey: PluginKey,
): AccountProjection | null => {
	if (!decl.capabilityKey.startsWith('account:')) return null;
	const name = decl.capabilityKey.slice('account:'.length);
	if (name.length === 0) return null;
	const strategy = decl.strategy as Partial<AccountProjection>;
	if (
		typeof strategy.address !== 'string' ||
		(strategy.scheme !== 'ed25519' &&
			strategy.scheme !== 'secp256k1' &&
			strategy.scheme !== 'secp256r1') ||
		(strategy.source !== 'real' && strategy.source !== 'impersonate')
	) {
		return null;
	}
	const funding = isAccountProjectionFunding(strategy.funding)
		? strategy.funding
		: { status: 'unknown' as const, balanceMist: null, requestedMist: null };
	return {
		key: `account/${name}` as `account/${string}`,
		rowKey,
		name,
		address: strategy.address,
		scheme: strategy.scheme,
		source: strategy.source,
		funding,
		walletVisible: false,
		updatedAt: Date.now(),
	};
};

const packageProjectionFromStrategy = (
	decl: StrategyContributorDecl<string, unknown>,
	rowKey: PluginKey,
): PackageProjection | null => {
	if (decl.capabilityKey !== 'package-registry') return null;
	const strategy = decl.strategy as Partial<PackageProjection>;
	if (
		(strategy.kind !== 'local' && strategy.kind !== 'known') ||
		typeof strategy.name !== 'string' ||
		typeof strategy.packageId !== 'string' ||
		typeof strategy.mvrPlaceholder !== 'string'
	) {
		return null;
	}
	const upgradeCapId =
		typeof strategy.upgradeCapId === 'string' ? strategy.upgradeCapId : null;
	const sourcePath = typeof strategy.sourcePath === 'string' ? strategy.sourcePath : null;
	return {
		key: `package/${strategy.name}` as `package/${string}`,
		rowKey,
		name: strategy.name,
		kind: strategy.kind,
		packageId: strategy.packageId,
		upgradeCapId,
		mvrPlaceholder: strategy.mvrPlaceholder,
		sourcePath,
		updatedAt: Date.now(),
	};
};

const isAccountProjectionFunding = (value: unknown): value is AccountProjection['funding'] => {
	if (typeof value !== 'object' || value === null) return false;
	const funding = value as Partial<AccountProjection['funding']>;
	const statusOk =
		funding.status === 'pending' ||
		funding.status === 'funded' ||
		funding.status === 'skipped' ||
		funding.status === 'failed' ||
		funding.status === 'unknown';
	return (
		statusOk &&
		(funding.balanceMist === null || typeof funding.balanceMist === 'string') &&
		(funding.requestedMist === null || typeof funding.requestedMist === 'string')
	);
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
