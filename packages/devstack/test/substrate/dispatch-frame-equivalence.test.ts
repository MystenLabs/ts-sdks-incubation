// ctx-emission → static-dispatch frame test.
//
// A plugin emits its five contribution kinds inline from `start` via the
// typed `ctx` verbs (ctx.snapshotExtra / ctx.codegen / ctx.endpoint /
// ctx.publish / ctx.provides), plus a static `errorContributions` field.
// The supervisor replays the ctx buffer through the closed
// `ContributionDispatcher` after a successful `start`. We assert:
//   - the ORDERED dispatched-contribution set (kind + payload
//     discriminator) matches the emit order,
//   - the routable endpoint "event" fires once,
//   - the strategy registration fires once,
//   - the plugin reaches `ready` (the static errorContributions feed +
//     the whole dispatch path completed cleanly).
//
// Plus the start-fails-after-emit case: a plugin that buffers decls via
// ctx then ERRORS in start must NOT dispatch anything (the post-start
// replay never runs on a failed start).
//
// (Stage B P4 deleted the legacy `capabilities` closure, so the former
// closure-vs-ctx equivalence assertion collapses to a single ctx path.)

import { Context, Effect, Ref, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import {
	supervise,
	makeProjectionRef,
	type ContributionDispatcher,
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
// Shared fixture decls.
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

// -----------------------------------------------------------------------------
// Capture harness — one ordered log across ALL kinds + per-kind detail,
// built as a `ContributionDispatcher` (the closed post-start seam).
// -----------------------------------------------------------------------------

interface Frame {
	readonly order: ReadonlyArray<string>;
	readonly endpointEvents: ReadonlyArray<string>;
	readonly strategy: ReadonlyArray<string>;
	readonly ready: boolean;
}

const makeCapture = () =>
	Effect.gen(function* () {
		const order = yield* Ref.make<ReadonlyArray<string>>([]);
		const endpointEvents = yield* Ref.make<ReadonlyArray<string>>([]);
		const strategy = yield* Ref.make<ReadonlyArray<string>>([]);
		const append = (ref: Ref.Ref<ReadonlyArray<string>>, v: string) =>
			Ref.update(ref, (xs) => [...xs, v]);

		const dispatcher: ContributionDispatcher = {
			snapshotable: (decl) => append(order, `snapshotable:${decl.subtrees[0]}`),
			codegenable: (decl) => append(order, `codegenable:${decl.emitterName}`),
			routable: (decl) =>
				Effect.gen(function* () {
					yield* append(order, `routable:${decl.endpointName}`);
					// The routable dispatch body is the production site that mints
					// + publishes the endpoint registration. We capture the
					// endpoint name as the event surface.
					yield* append(endpointEvents, `endpoint.registered:${decl.endpointName}`);
				}),
			projection: (decl) => append(order, `projection:${decl.event.kind}`),
			strategyContributor: (decl) =>
				Effect.gen(function* () {
					yield* append(order, `strategy-contributor:${decl.capabilityKey}`);
					yield* append(strategy, decl.capabilityKey);
				}),
		};
		return { order, endpointEvents, strategy, dispatcher };
	});

const runPlugin = (member: SupervisedStack['members'][number], rowKey: string) =>
	Effect.gen(function* () {
		const { order, endpointEvents, strategy, dispatcher } = yield* makeCapture();
		const stack: SupervisedStack = { _tag: 'Stack', members: [member], options: {} };
		const state = yield* makeProjectionRef();

		const ready = yield* Effect.scoped(
			Effect.gen(function* () {
				const handle = yield* supervise(stack, identity, state, Context.empty(), dispatcher);
				for (const [key] of handle.graph.nodes) {
					yield* handle.registry.awaitReady(key);
				}
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
// ctx-verbs plugin — emits the five decls in order from `start`.
// `errorContributions` stays a static field (it is NOT a ctx verb).
// -----------------------------------------------------------------------------

const ctxPlugin = definePlugin({
	id: 'frame:ctx',
	role: 'service' as const,
	section: 'service',
	start: (_deps: unknown, ctx: PluginCtx) =>
		Effect.sync(() => {
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
// ctx plugin that ERRORS after buffering — must NOT dispatch.
// -----------------------------------------------------------------------------

const ctxFailPlugin = definePlugin({
	id: 'frame:ctx-fail',
	role: 'service' as const,
	section: 'service',
	start: (_deps: unknown, ctx: PluginCtx) =>
		Effect.gen(function* () {
			// Buffer an endpoint (and more) ...
			ctx.endpoint(routeDecl);
			ctx.snapshotExtra(snapDecl);
			// ... then fail. The buffer must be DISCARDED (no replay/dispatch).
			yield* Effect.fail({ _tag: 'StartBoom' as const });
			return { v: 'ctx-fail' as const };
		}),
	errorContributions: [errorContrib],
});

describe('ctx-emission → static dispatch (P3/P4)', () => {
	it.effect('buffered ctx verbs dispatch in emit order through the closed dispatcher', () =>
		Effect.gen(function* () {
			const ctxFrame = yield* runPlugin(ctxPlugin, 'frame:ctx#0');

			expect(ctxFrame.order).toEqual([
				'snapshotable:runtime/frame-subtree',
				'codegenable:frame-emitter',
				'routable:frame-endpoint',
				'projection:account',
				'strategy-contributor:frame-strategy',
			]);
			expect(ctxFrame.endpointEvents).toEqual(['endpoint.registered:frame-endpoint']);
			expect(ctxFrame.strategy).toEqual(['frame-strategy']);
			expect(ctxFrame.ready).toBe(true);
		}),
	);

	it.effect('start-fails-after-endpoint buffers but does NOT dispatch', () =>
		Effect.gen(function* () {
			const { order, endpointEvents, strategy, dispatcher } = yield* makeCapture();
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [ctxFailPlugin],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* supervise(stack, identity, state, Context.empty(), dispatcher);
					for (const [key] of handle.graph.nodes) {
						yield* handle.registry.awaitReady(key).pipe(Effect.ignore);
					}
				}),
			);

			// NOTHING dispatched: buffered decls discarded on the failed start.
			expect(yield* Ref.get(order)).toEqual([]);
			expect(yield* Ref.get(endpointEvents)).toEqual([]);
			expect(yield* Ref.get(strategy)).toEqual([]);

			const snap = yield* SubscriptionRef.get(state);
			const row = snap.rows.find((r) => r.key === 'frame:ctx-fail#0');
			expect(row?.status).not.toBe('ready');
		}),
	);
});
