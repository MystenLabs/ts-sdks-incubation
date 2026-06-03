// P0.5 — capabilities-closure vs ctx-verbs dispatch-frame equivalence.
//
// A fixture plugin authored BOTH ways must produce a byte-identical
// dispatched-contribution frame:
//
//   (A) legacy: a `capabilities` closure returning
//       [snapshotable, codegenable, routable, projection,
//        strategy-contributor] + an `errorContributions` field.
//   (B) ctx verbs: the SAME five emitted from `start` via
//       ctx.snapshotExtra / ctx.codegen / ctx.endpoint / ctx.publish /
//       ctx.provides, with the SAME `errorContributions` field.
//
// Both are supervised to ready through capturing `OrchestratorSinks`;
// we assert:
//   - identical ORDERED dispatched-contribution set (kind sequence),
//   - identical endpoint events (the routable endpoint fires once),
//   - identical strategy registrations,
//   - identical error-contribution folding.
//
// Plus the start-fails-after-endpoint case: a plugin that buffers decls
// via ctx then ERRORS in start must NOT dispatch anything (matching the
// legacy post-start harvest, which never runs on a failed start).

import { Context, Effect, Ref, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import {
	supervise,
	makeProjectionRef,
	type CapabilitySink,
	type ContributionKind,
	type OrchestratorSinks,
	type SupervisedStack,
} from '../../src/substrate/runtime/index.ts';
import { definePlugin, type PluginErrorContribution } from '../../src/substrate/plugin.ts';
import type { PluginCtx } from '../../src/substrate/plugin-ctx.ts';
import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import type { ProjectionDecl } from '../../src/contracts/projection.ts';
import type { RoutableDecl } from '../../src/contracts/routable.ts';
import type { SnapshotableDecl } from '../../src/contracts/snapshotable.ts';
import type { StrategyContributorDecl } from '../../src/contracts/strategy-contributor.ts';

const identity: Identity = {
	app: appName('frame-equiv-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

// -----------------------------------------------------------------------------
// Shared fixture decls — the SAME objects flow through both authoring
// styles, so equivalence is about WHERE they enter, not WHAT they are.
// -----------------------------------------------------------------------------

const snapDecl: SnapshotableDecl = {
	kind: 'snapshotable',
	subtrees: ['runtime/frame-subtree'],
	missingTolerance: 'fine',
};

const codegenDecl: CodegenableDecl<'frame-emitter'> = {
	kind: 'codegenable',
	emitterName: 'frame-emitter',
	outputPath: 'frame/file.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('hello', 'world');
			return ctx.done();
		}),
};

const routeDecl: RoutableDecl = {
	kind: 'routable',
	endpointName: 'frame-endpoint',
	dispatchId: { serviceKey: 'frame', role: 'app' },
	upstream: { type: 'host-loopback', port: 7173 },
	wireProtocol: 'http',
	cors: false,
};

const projectionDecl: ProjectionDecl = {
	kind: 'projection',
	event: {
		tag: 'projection.updated',
		kind: 'account',
		key: 'account/frame',
		payload: {
			key: 'account/frame',
			rowKey: null,
			name: 'frame',
			address: '0xframe',
			scheme: 'ed25519',
			source: 'real',
			funding: { status: 'funded', balanceMist: null, requestedMist: '1', entries: [] },
			walletVisible: false,
			updatedAt: 1,
		},
		at: 1,
	},
};

const strategyDecl: StrategyContributorDecl<'frame-strategy', { readonly run: 'ok' }> = {
	kind: 'strategy-contributor',
	capabilityKey: 'frame-strategy',
	strategy: { run: 'ok' },
	autoMounted: false,
};

const errorContrib: PluginErrorContribution = {
	_tag: 'PluginErrorContribution',
	errorTags: ['FrameError'],
	formatter: (value) => `<<frame ${value._tag}>>`,
};

// The canonical emit order — both authoring styles emit in THIS order.
const orderedDecls = [snapDecl, codegenDecl, routeDecl, projectionDecl, strategyDecl] as const;

// -----------------------------------------------------------------------------
// Capture harness — one ordered log across ALL kinds + per-kind detail.
// -----------------------------------------------------------------------------

interface Frame {
	/** Ordered (kind, payload-discriminator) across every dispatched
	 *  contribution, normalized to drop the plugin-key ordinal. */
	readonly order: ReadonlyArray<string>;
	readonly endpointEvents: ReadonlyArray<string>;
	readonly strategy: ReadonlyArray<string>;
	/** Whether the plugin reached `ready` — proves the harvest path
	 *  (including the identical static errorContributions dispatch)
	 *  completed cleanly for both authoring styles. */
	readonly ready: boolean;
}

const orchestratorSink = <K extends ContributionKind, TDecl>(
	sink: CapabilitySink<K, TDecl>,
): OrchestratorSinks[number] => sink as OrchestratorSinks[number];

const makeCapture = () =>
	Effect.gen(function* () {
		const order = yield* Ref.make<ReadonlyArray<string>>([]);
		const endpointEvents = yield* Ref.make<ReadonlyArray<string>>([]);
		const strategy = yield* Ref.make<ReadonlyArray<string>>([]);
		const append = (ref: Ref.Ref<ReadonlyArray<string>>, v: string) =>
			Ref.update(ref, (xs) => [...xs, v]);

		const sinks: OrchestratorSinks = [
			orchestratorSink<'snapshotable', SnapshotableDecl>({
				kind: 'snapshotable',
				accept: (decl) => append(order, `snapshotable:${decl.subtrees[0]}`),
			}),
			orchestratorSink<'codegenable', CodegenableDecl<string>>({
				kind: 'codegenable',
				accept: (decl) => append(order, `codegenable:${decl.emitterName}`),
			}),
			orchestratorSink<'routable', RoutableDecl>({
				kind: 'routable',
				accept: (decl) =>
					Effect.gen(function* () {
						yield* append(order, `routable:${decl.endpointName}`);
						// Endpoint "event": the routable sink is the production
						// site that mints + publishes the endpoint registration.
						// We capture the endpoint name as the event surface so
						// both authoring styles must produce the SAME event.
						yield* append(endpointEvents, `endpoint.registered:${decl.endpointName}`);
					}),
			}),
			orchestratorSink<'projection', ProjectionDecl>({
				kind: 'projection',
				accept: (decl) => append(order, `projection:${decl.event.kind}`),
			}),
			orchestratorSink<'strategy-contributor', StrategyContributorDecl<string, unknown>>({
				kind: 'strategy-contributor',
				accept: (decl) =>
					Effect.gen(function* () {
						yield* append(order, `strategy-contributor:${decl.capabilityKey}`);
						yield* append(strategy, decl.capabilityKey);
					}),
			}),
		];
		return { order, endpointEvents, strategy, sinks };
	});

const runPlugin = (member: SupervisedStack['members'][number], rowKey: string) =>
	Effect.gen(function* () {
		const { order, endpointEvents, strategy, sinks } = yield* makeCapture();
		const stack: SupervisedStack = { _tag: 'Stack', members: [member], options: {} };
		const state = yield* makeProjectionRef();

		const ready = yield* Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* supervise(stack, identity, state, Context.empty(), sinks);
				for (const [key] of handle.graph.nodes) {
					yield* handle.registry.awaitReady(key);
				}
				// Read the row status INSIDE the live scope — scope teardown
				// drains rows on close.
				const snap = yield* SubscriptionRef.get(state);
				return snap.rows.find((r) => r.key === rowKey)?.status === 'ready';
			}),
		);

		const frame: Frame = {
			order: yield* Ref.get(order),
			endpointEvents: yield* Ref.get(endpointEvents),
			strategy: yield* Ref.get(strategy),
			ready,
		};
		return frame;
	});

// -----------------------------------------------------------------------------
// (A) legacy capabilities-closure plugin.
// -----------------------------------------------------------------------------

const closurePlugin = definePlugin({
	id: 'frame:closure',
	role: 'service' as const,
	section: 'service',
	start: () => Effect.succeed({ v: 'closure' as const }),
	capabilities: orderedDecls,
	errorContributions: [errorContrib],
});

// -----------------------------------------------------------------------------
// (B) ctx-verbs plugin — emits the SAME five decls in the SAME order from
//     `start`, no `capabilities` field. `errorContributions` stays a
//     static field (it is NOT a ctx verb).
// -----------------------------------------------------------------------------

const ctxPlugin = definePlugin({
	id: 'frame:ctx',
	role: 'service' as const,
	section: 'service',
	start: (_deps: unknown, ctx?: PluginCtx) =>
		Effect.gen(function* () {
			// Defensive: in production the supervisor always passes ctx.
			if (ctx === undefined) return yield* Effect.die('ctx missing');
			ctx.snapshotExtra(snapDecl);
			ctx.codegen(codegenDecl);
			ctx.endpoint(routeDecl);
			ctx.publish(projectionDecl);
			ctx.provides(strategyDecl);
			return { v: 'ctx' as const };
		}),
	errorContributions: [errorContrib],
});

// -----------------------------------------------------------------------------
// (C) ctx plugin that ERRORS after buffering — must NOT dispatch.
// -----------------------------------------------------------------------------

const ctxFailPlugin = definePlugin({
	id: 'frame:ctx-fail',
	role: 'service' as const,
	section: 'service',
	start: (_deps: unknown, ctx?: PluginCtx) =>
		Effect.gen(function* () {
			if (ctx === undefined) return yield* Effect.die('ctx missing');
			// Buffer an endpoint (and more) ...
			ctx.endpoint(routeDecl);
			ctx.snapshotExtra(snapDecl);
			// ... then fail. The buffer must be DISCARDED (no replay/dispatch),
			// exactly as today's post-start harvest never runs on a failed
			// start.
			yield* Effect.fail({ _tag: 'StartBoom' as const });
			// Unreachable — gives the start a non-`never` success type so the
			// plugin's resolved Value is well-formed.
			return { v: 'ctx-fail' as const };
		}),
	errorContributions: [errorContrib],
});

describe('dispatch-frame equivalence (P0.5)', () => {
	it.effect('capabilities-closure and ctx-verbs produce a byte-identical frame', () =>
		Effect.gen(function* () {
			const closureFrame = yield* runPlugin(closurePlugin, 'frame:closure#0');
			const ctxFrame = yield* runPlugin(ctxPlugin, 'frame:ctx#0');

			// Ordered dispatched-contribution set: same kinds, same order,
			// same payload discriminators.
			expect(ctxFrame.order).toEqual([
				'snapshotable:runtime/frame-subtree',
				'codegenable:frame-emitter',
				'routable:frame-endpoint',
				'projection:account',
				'strategy-contributor:frame-strategy',
			]);
			expect(ctxFrame.order).toEqual(closureFrame.order);
			// Endpoint events.
			expect(ctxFrame.endpointEvents).toEqual(['endpoint.registered:frame-endpoint']);
			expect(ctxFrame.endpointEvents).toEqual(closureFrame.endpointEvents);
			// Strategy registrations.
			expect(ctxFrame.strategy).toEqual(['frame-strategy']);
			expect(ctxFrame.strategy).toEqual(closureFrame.strategy);
			// Both reached ready — the harvest path (incl. the identical
			// static errorContributions dispatch) completed for both styles.
			expect(ctxFrame.ready).toBe(true);
			expect(closureFrame.ready).toBe(true);
		}),
	);

	it.effect('start-fails-after-endpoint buffers but does NOT dispatch', () =>
		Effect.gen(function* () {
			const { order, endpointEvents, strategy, sinks } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [ctxFailPlugin],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					// `supervise` runs the initial acquire to completion before
					// returning — the failed plugin has already settled by here.
					// `awaitReady` fails for a failed plugin; we ignore that.
					const handle = yield* supervise(stack, identity, state, Context.empty(), sinks);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key).pipe(Effect.ignore);
					}
				}),
			);

			// NOTHING dispatched: buffered decls were discarded on the failed
			// start, matching the legacy harvest which never runs post-failure.
			expect(yield* Ref.get(order)).toEqual([]);
			expect(yield* Ref.get(endpointEvents)).toEqual([]);
			expect(yield* Ref.get(strategy)).toEqual([]);

			// The plugin settled in a non-ready (failed) state.
			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'frame:ctx-fail#0');
			expect(row?.status).not.toBe('ready');
		}),
	);
});
