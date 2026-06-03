// Regression test for backlog #39: contribution-dispatch failure routing.
//
// A contribution-dispatch BODY failure (an orchestrator-side bug, e.g. a
// router route collision) must NOT mark the plugin failed. The supervisor:
//   1. leaves the plugin `ready` (or `done` for tasks), and
//   2. publishes `engine.orchestrator.dispatchFailed` carrying the failing
//      kind + the originating plugin key + the cause `_tag`.
//
// Plugin authoring stays unchanged: a dispatch body that throws is an
// orchestrator-side bug, NOT a plugin-side bug.

import { Data, Effect, Queue, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../src/substrate/events.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import { definePlugin } from '../../../src/substrate/plugin.ts';
import type { PluginCtx } from '../../../src/substrate/plugin-ctx.ts';
import {
	makeProjectionRef,
	noopContributionDispatcher,
	startSupervisor,
	type ContributionDispatcher,
	type SupervisedStack,
} from '../../../src/substrate/runtime/index.ts';
import type { CodegenableDecl } from '../../../src/contracts/codegenable.ts';

const identity: Identity = {
	app: appName('contribution-sink-fail-test-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

const codegenDecl: CodegenableDecl<'failing-emitter'> = {
	kind: 'codegenable',
	emitterName: 'failing-emitter',
	outputPath: 'failing/file.ts',
	emit: (ctx) =>
		Effect.sync(() => {
			ctx.exportConst('x', '1');
			return ctx.done();
		}),
};

// Stand-in for an orchestrator-side domain error (e.g. `RouterBootFailed`):
// a tagged error so the supervisor lifts its `_tag` onto the
// `dispatchFailed` event's additive `causeType`.
class SinkBootFailed extends Data.TaggedError('SinkBootFailed')<{
	readonly detail: string;
}> {}

const SINK_FAILURE_DETAIL = 'router spec mismatch: upstream sui:rpc not reachable';

// A dispatcher whose `codegenable` body REJECTS, exercising the
// orchestrator-fault path deterministically. Every other kind is a no-op.
const failingDispatcher: ContributionDispatcher = {
	...noopContributionDispatcher,
	codegenable: () => Effect.fail(new SinkBootFailed({ detail: SINK_FAILURE_DETAIL })),
};

describe('supervisor — contribution-dispatch failure routing (backlog #39)', () => {
	it.effect('does not mark plugin failed when a dispatch body rejects', () =>
		Effect.gen(function* () {
			const plugin = definePlugin({
				id: 'test:sink-fail-plugin',
				role: 'service' as const,
				section: 'service',
				start: (_deps: unknown, ctx: PluginCtx) =>
					Effect.sync(() => {
						ctx.codegen(codegenDecl);
						return { v: 'ok' as const };
					}),
			});
			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [plugin],
				options: {},
			};
			const state = yield* makeProjectionRef();
			const dispatchFailedSeen = yield* Ref.make<ReadonlyArray<EngineEvent>>([]);

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						undefined,
						failingDispatcher,
					);
					yield* Effect.forkScoped(
						Effect.gen(function* () {
							while (true) {
								const event = yield* Queue.take(startup.handle.events);
								if (event.tag === 'engine.orchestrator.dispatchFailed') {
									yield* Ref.update(dispatchFailedSeen, (current) => [...current, event]);
								}
							}
						}),
					);
					yield* startup.runInitialAcquire;

					const key = pluginKey('test:sink-fail-plugin#0');
					let lastStatus: string | null = null;
					for (let i = 0; i < 50; i++) {
						lastStatus = yield* startup.handle.registry
							.getStatus(key)
							.pipe(Effect.catch(() => Effect.succeed('failed')));
						if (lastStatus === 'ready' || lastStatus === 'done' || lastStatus === 'failed') {
							break;
						}
						yield* Effect.yieldNow;
					}
					expect(lastStatus).not.toBe('failed');

					for (let i = 0; i < 50; i++) {
						const seen = yield* Ref.get(dispatchFailedSeen);
						if (seen.length > 0) break;
						yield* Effect.yieldNow;
					}
					const seen = yield* Ref.get(dispatchFailedSeen);
					expect(seen.length).toBeGreaterThanOrEqual(1);
					const first = seen[0]!;
					expect(first.tag).toBe('engine.orchestrator.dispatchFailed');
					if (first.tag === 'engine.orchestrator.dispatchFailed') {
						expect(first.kind).toBe('codegenable');
						// The underlying cause's `_tag` must ride along so a
						// renderer/log consumer can name WHICH orchestrator broke.
						expect(first.causeType).toBe('SinkBootFailed');
					}

					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					yield* startup.handle.awaitShutdown;
				}),
			);
		}),
	);
});
