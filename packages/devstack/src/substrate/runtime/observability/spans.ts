// Span propagation wrappers.
//
// Architecture § L0 Observability: "span/annotation conventions".
// Centralises the attribute keys so every wrapped span uses the same
// vocabulary — OTEL consumers can filter by `devstack.app`,
// `devstack.stack`, `devstack.plugin`, `devstack.role` reliably.
//
// Discipline: no service names appear anywhere; only the four
// engine-level dimensions. Plugins call `withPluginSpan` and pass
// their `pluginKey` + `role`.

import { Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { PluginRole } from '../../lifecycle.ts';

/** Canonical span-attribute keys. Single source of truth for the
 *  observability vocabulary. */
export const SpanAttr = {
	accountFundingFrom: 'account.funding.from',
	accountFundingTo: 'account.funding.to',
	accountName: 'account.name',
	app: 'devstack.app',
	stack: 'devstack.stack',
	network: 'devstack.network',
	coinType: 'coin.type',
	plugin: 'devstack.plugin',
	role: 'devstack.role',
	phase: 'devstack.phase',
	containerName: 'container.name',
	containerRole: 'container.role',
	event: 'event.name',
	errorCode: 'error.code',
	errorCause: 'error.cause',
	errorMessage: 'error.message',
	exitCode: 'process.exit.code',
	exitSignal: 'process.exit.signal',
	exitStatus: 'process.exit.status',
	endpointKey: 'devstack.endpoint.key',
	httpMethod: 'http.method',
	httpPath: 'http.path',
	httpUrl: 'http.url',
	host: 'server.address',
	logTag: 'log.tag',
	port: 'server.port',
	cycleId: 'devstack.cycle.id',
	op: 'devstack.op',
	requestId: 'devstack.request.id',
	rosterHeartbeatIntervalMs: 'roster.heartbeat.intervalMs',
	serviceName: 'devstack.service.name',
	stageAndSwapStagingPath: 'stageAndSwap.stagingPath',
	stageAndSwapTargetPath: 'stageAndSwap.targetPath',
	suiAutoTickIntervalMs: 'sui.autoTick.intervalMs',
	suiMode: 'sui.mode',
	walletToken: 'wallet.token',
	walletBearerValid: 'wallet.auth.bearerValid',
	walletLocalhostViteEnabled: 'wallet.localhostViteEnabled',
	walletOrigin: 'wallet.origin',
	walletTokenFile: 'wallet.tokenFile',
	walletUrl: 'wallet.url',
} as const;

export interface StackSpanContext {
	readonly app: string;
	readonly stack: string;
	readonly network: string;
}

export interface PluginSpanContext extends StackSpanContext {
	readonly pluginKey: PluginKey;
	readonly role: PluginRole;
}

/**
 * Wrap an Effect in a stack-scoped span. Sets `devstack.app`,
 * `devstack.stack`, `devstack.network` attributes. Use at the
 * top-level engine entry points (boot, cycle start, supervisor
 * loop) — not inside per-plugin code (use `withPluginSpan` for that).
 */
export const withStackSpan =
	(name: string, ctx: StackSpanContext) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		effect.pipe(
			Effect.withSpan(name, {
				attributes: {
					[SpanAttr.app]: ctx.app,
					[SpanAttr.stack]: ctx.stack,
					[SpanAttr.network]: ctx.network,
				},
			}),
		);

/**
 * Wrap an Effect in a plugin-scoped span. Inherits stack identity from
 * the surrounding Context (callers should compose with
 * `withStackSpan` at the top so the stack identity propagates).
 */
export const withPluginSpan =
	(name: string, ctx: PluginSpanContext) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		effect.pipe(
			Effect.withSpan(name, {
				attributes: {
					[SpanAttr.app]: ctx.app,
					[SpanAttr.stack]: ctx.stack,
					[SpanAttr.network]: ctx.network,
					[SpanAttr.plugin]: ctx.pluginKey,
					[SpanAttr.role]: ctx.role,
				},
			}),
		);

/**
 * Annotate the current span with a phase marker. Cheap; safe to call
 * from anywhere. Used by the supervisor when transitioning a plugin
 * through acquire phases so the OTEL trace correlates with the
 * lifecycle stream.
 */
export const annotatePhase = (phase: string): Effect.Effect<void> =>
	Effect.annotateCurrentSpan({ [SpanAttr.phase]: phase });

/**
 * Annotate the current span with the engine cycle id. Called once per
 * cycle at supervisor entry.
 */
export const annotateCycle = (cycleId: number): Effect.Effect<void> =>
	Effect.annotateCurrentSpan({ [SpanAttr.cycleId]: cycleId });

/**
 * Annotate the current span with a subprocess `op` tag. Mirrors the
 * `CaptureError.op` field so a failure that originates in a captured
 * subprocess can be traced back to its span by `devstack.op`.
 */
export const annotateOp = (op: string): Effect.Effect<void> =>
	Effect.annotateCurrentSpan({ [SpanAttr.op]: op });
