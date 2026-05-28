// Span propagation wrappers.
//
// Architecture § L0 Observability: "span/annotation conventions".
// Centralises the attribute keys so every wrapped span uses the same
// vocabulary — OTEL consumers can filter by `devstack.app`,
// `devstack.stack`, `devstack.plugin`, `devstack.role` reliably.
//
// Discipline: substrate-owned vocabulary carries ONLY engine-dimensional
// keys (`devstack.*`, `error.*`, `process.exit.*`, `container.*`) plus
// HTTP-generic keys (`http.*`, `server.*`). Plugin-domain keys
// (`wallet.token`, `sui.mode`, `account.name`, etc.) live in
// `src/plugins/<name>/spans.ts` next to the plugin that owns them; see
// STYLE_GUIDE §16.

import { Effect } from 'effect';

import type { PluginKey } from '../../brand.ts';
import type { PluginRole } from '../../lifecycle.ts';
import { IdentityContext } from '../paths.ts';

/** Canonical span-attribute keys. Engine-dimensional + http/process
 *  generic only. Plugin-domain keys belong on per-plugin `spans.ts`. */
export const SpanAttr = {
	app: 'devstack.app',
	stack: 'devstack.stack',
	network: 'devstack.network',
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

/**
 * Canonical labels every `spanWithLabels` span carries. `plugin` is
 * caller-supplied (per-acquisition); `endpoint` + `op` are optional
 * canonical narrowers — anything plugin-specific goes through `extras`
 * so the OTEL namespace check (STYLE_GUIDE §16) still applies.
 */
export interface SpanLabels {
	readonly plugin: PluginKey | string;
	readonly endpoint?: string;
	readonly op?: string;
}

/**
 * Wrap an Effect in a span that pre-bakes the canonical identity
 * footprint — `devstack.app` + `devstack.stack` (read from the ambient
 * `IdentityContext`) + `devstack.plugin` from `labels.plugin`. Reach
 * for this on any span that needs to be filterable or groupable by
 * plugin on the dashboard (i.e. basically every span). Coexists with
 * raw `Effect.withSpan` — migration is incremental, not a flag day.
 */
export const spanWithLabels =
	(name: string, labels: SpanLabels, extras?: Record<string, unknown>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | IdentityContext> =>
		Effect.gen(function* () {
			const identity = yield* IdentityContext;
			const attributes: Record<string, unknown> = {
				[SpanAttr.app]: identity.app,
				[SpanAttr.stack]: identity.stack,
				[SpanAttr.plugin]: labels.plugin,
				...(labels.endpoint !== undefined ? { [SpanAttr.endpointKey]: labels.endpoint } : {}),
				...(labels.op !== undefined ? { [SpanAttr.op]: labels.op } : {}),
				...extras,
			};
			return yield* effect.pipe(Effect.withSpan(name, { attributes }));
		});
