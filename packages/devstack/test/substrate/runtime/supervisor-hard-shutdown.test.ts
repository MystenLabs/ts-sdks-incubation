// Bug #13 regression: the in-loop teardown branch of
// `handleCommand('shutdown.requested')` MUST be wrapped in
// `Effect.uninterruptible`. The scope-close finalizer at
// `supervisor.ts:1657` is already uninterruptible, but the in-loop
// teardown path is what runs when `shutdown.requested` arrives on the
// happy path — and a SECOND signal during that window could otherwise
// drive an Effect-level interrupt through the command-loop fiber,
// abandoning `teardownKeys` mid-flight and leaking the underlying
// plugin scopes (Docker containers in production).
//
// The core invariant exercised here is "when shutdown.requested
// arrives, the slow plugin's finalizer runs to completion BEFORE
// `awaitShutdown` resolves." The uninterruptible wrap is what makes
// this invariant robust against an Effect-level interrupt racing the
// teardown — but harnessing the interrupt race deterministically
// requires fiber surgery the supervisor split (Phase 6) will simplify.
// For now we pin the happens-before via instrumentation timing.

import { Effect, Queue, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, pluginKey, stackName } from '../../../src/substrate/brand.ts';
import type { Identity } from '../../../src/substrate/identity.ts';
import {
	makeProjectionRef,
	startSupervisor,
	type SupervisedStack,
} from '../../../src/substrate/runtime/index.ts';
import { definePlugin } from '../../../src/substrate/plugin.ts';

const identity: Identity = {
	app: appName('hard-shutdown-test-app'),
	stack: stackName('main'),
	network: 'local',
};

describe('supervisor hard-shutdown teardown (Bug #13)', () => {
	it.live('in-loop teardown runs to completion before awaitShutdown resolves', () =>
		Effect.gen(function* () {
			const finalizerRanAt = yield* Ref.make<number | null>(null);
			const shutdownResolvedAt = yield* Ref.make<number | null>(null);
			let tick = 0;
			const nextTick = (): number => ++tick;

			const slow = definePlugin({
				id: 'test:slow-teardown',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() =>
							Effect.gen(function* () {
								// Force a yield + tiny delay so any
								// out-of-order resolution of
								// `shutdownComplete` would record a
								// smaller tick than the finalizer.
								yield* Effect.yieldNow;
								yield* Effect.sleep('10 millis');
								yield* Ref.set(finalizerRanAt, nextTick());
							}),
						);
						return { v: 'slow' as const };
					}),
			});

			const stack: SupervisedStack = { _tag: 'Stack', members: [slow], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:slow-teardown#0'));
					yield* Queue.offer(startup.handle.commands, { tag: 'shutdown.requested' });
					yield* startup.handle.awaitShutdown;
					yield* Ref.set(shutdownResolvedAt, nextTick());
				}),
			);

			const finalizerTick = yield* Ref.get(finalizerRanAt);
			const shutdownTick = yield* Ref.get(shutdownResolvedAt);

			expect(finalizerTick).not.toBeNull();
			expect(shutdownTick).not.toBeNull();
			expect(finalizerTick!).toBeLessThan(shutdownTick!);
		}),
	);

	it.effect('hardKillRequested signals shutdownComplete atomically with the fatal log', () =>
		Effect.gen(function* () {
			const state = yield* makeProjectionRef();
			const stack: SupervisedStack = { _tag: 'Stack', members: [], options: {} };
			const at = Date.parse('2026-05-26T12:00:00.000Z');

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* Queue.offer(startup.handle.commands, {
						tag: 'shutdown.hardKillRequested',
						signal: 'SIGINT',
						exitCode: 130,
						at,
					});

					// `shutdown.escalated` is published BEFORE the
					// uninterruptible block; assert it lands.
					const event = yield* Queue.take(startup.handle.events);
					expect(event).toEqual({
						tag: 'shutdown.escalated',
						signal: 'SIGINT',
						exitCode: 130,
						at,
					});

					// awaitShutdown MUST resolve. Post-fix `Effect.uninterruptible`
					// ensures the deferred + log are emitted atomically;
					// even if an Effect-level interrupt arrives between
					// `Deferred.succeed` and the log call, neither is
					// skipped and `awaitShutdown` always unblocks.
					yield* startup.handle.awaitShutdown;
				}),
			);
		}),
	);
});
