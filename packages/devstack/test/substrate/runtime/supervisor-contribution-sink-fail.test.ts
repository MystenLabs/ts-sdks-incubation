// Regression test for backlog #39: ContributionSinkFailed routing.
//
// Before the Phase 6 split, dispatchContributions only caught
// `UnknownContributionKind` from `sinks.dispatch()`. The error channel
// ALSO yielded `ContributionSinkFailed` (a registered sink rejected
// while handling a known kind). The wrapping `Effect.exit` at the
// acquire-node callsite then projected the failure through
// `registry.markFailed`, misattributing the orchestrator's broken sink
// to the originating plugin.
//
// Post-split behavior asserted here:
//   1. A sink that rejects (returns `Effect.fail(...)`) DOES NOT cause
//      the plugin to be marked failed — the plugin reaches `ready`
//      (or `done` for tasks).
//   2. The supervisor publishes an
//      `engine.orchestrator.dispatchFailed` event carrying the failing
//      kind + the originating plugin key.
//
// Plugin authoring stays unchanged: a registered sink that throws is
// an orchestrator-side bug, NOT a plugin-side bug.

import { Effect, Queue, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../src/substrate/events.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import { definePlugin } from '../../../src/substrate/plugin.ts';
import {
	CapabilitySinksService,
	layerCapabilitySinksDefault,
	makeProjectionRef,
	startSupervisor,
	type CapabilitySink,
	type OrchestratorSinks,
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

const failingSink: CapabilitySink<'codegenable', CodegenableDecl<string>> = {
	kind: 'codegenable',
	accept: () => Effect.fail(new Error('orchestrator-side router collision')),
};

// `OrchestratorSinks` is the supervisor's caller-facing bag of sinks.
// We register exactly the failing sink for the codegenable kind so the
// dispatch path traverses `ContributionSinkFailed` deterministically.
const sinks: OrchestratorSinks = [failingSink as unknown as OrchestratorSinks[number]];

describe('supervisor — ContributionSinkFailed routing (backlog #39)', () => {
	it.effect('does not mark plugin failed when a sink rejects', () =>
		Effect.gen(function* () {
			const plugin = definePlugin({
				id: 'test:sink-fail-plugin',
				role: 'service' as const,
				section: 'service',
				start: () => Effect.succeed({ v: 'ok' as const }),
				capabilities: [codegenDecl] as const,
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
					const startup = yield* startSupervisor(stack, identity, state, undefined, sinks);
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

					// Settle: yield repeatedly until the plugin's status reaches a
					// terminal state. With the bug present, status would be
					// `failed` — without it the plugin reaches `ready`/`done`.
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

					// Allow the dispatchFailed publish to drain.
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
					}

					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					yield* startup.handle.awaitShutdown;
				}),
			);
		}),
	);

	// Direct unit-style test against the CapabilitySinks service: even
	// without going through the full supervisor, the dispatch surface is
	// the discriminator between UnknownContributionKind and
	// ContributionSinkFailed. The split contract: BOTH errors are
	// surfaceable; only one is "plugin-fault".
	it.effect('dispatch surface yields ContributionSinkFailed on sink reject', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const sinks = yield* CapabilitySinksService;
				const exit = yield* Effect.exit(
					sinks.dispatch(
						{ source: 'capability', decl: codegenDecl },
						{
							pluginKey: pluginKey('test:dispatch-direct#0'),
							identity,
							publish: () => Effect.void,
							registerStrategy: () => Effect.void,
						},
					),
				);
				expect(exit._tag).toBe('Failure');
				if (exit._tag === 'Failure') {
					const errs = exit.cause.reasons.filter((r) => r._tag === 'Fail');
					expect(errs.length).toBeGreaterThanOrEqual(1);
					const e = (errs[0] as { error: { _tag: string; kind?: string } }).error;
					expect(e._tag).toBe('ContributionSinkFailed');
					expect(e.kind).toBe('codegenable');
				}
			}).pipe(
				Effect.provide(
					layerCapabilitySinksDefault([failingSink as unknown as OrchestratorSinks[number]]),
				),
			),
		),
	);
});
