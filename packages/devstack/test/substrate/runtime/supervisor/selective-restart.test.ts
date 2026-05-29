// Supervisor selective-restart orchestration.
//
// `supervisor.test.ts` already pins the single-plugin hot-restart
// (fresh scope + ready gate, finalizer count). This file complements it
// by exercising the DOWNSTREAM-CLOSURE + ISOLATION behavior of
// `doSelectiveRestart` (teardown.ts):
//
//   - restarting one key re-acquires that key PLUS its downstream
//     closure, in dep order — the downstream's re-run sees the FRESH
//     upstream resolved value,
//   - plugins OUTSIDE the slice are untouched: their `start` body is not
//     re-run and their finalizer does not fire,
//   - `restart.requested` / `restart.completed` bracket the slice work.
//
// Driven through the live command loop (`Queue.offer` of
// `selective-restart.requested`, then wait for `restart.completed`) to
// match the established harness in `supervisor.test.ts`.

import { Effect, Queue, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../../src/substrate/brand.ts';
import type { EngineEvent } from '../../../../src/substrate/events.ts';
import type { Identity } from '../../../../src/substrate/identity.ts';
import {
	makeProjectionRef,
	startSupervisor,
	type SupervisedStack,
} from '../../../../src/substrate/runtime/index.ts';
import { definePlugin } from '../../../../src/substrate/plugin.ts';

const identity: Identity = {
	app: appName('selective-restart-test-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

describe('supervisor selective restart', () => {
	it.effect('re-acquires the target + downstream closure, leaving unrelated plugins untouched', () =>
		Effect.gen(function* () {
			// Per-plugin start / finalizer counters.
			const producerStarts = yield* Ref.make(0);
			const consumerStarts = yield* Ref.make(0);
			const independentStarts = yield* Ref.make(0);
			const producerFinalizers = yield* Ref.make(0);
			const consumerFinalizers = yield* Ref.make(0);
			const independentFinalizers = yield* Ref.make(0);

			const producer = definePlugin({
				id: 'test:producer',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						const n = yield* Ref.updateAndGet(producerStarts, (x) => x + 1);
						yield* Effect.addFinalizer(() => Ref.update(producerFinalizers, (x) => x + 1));
						return { token: `producer-${n}` };
					}),
			});
			const consumer = definePlugin({
				id: 'test:consumer',
				role: 'service' as const,
				section: 'service',
				dependsOn: producer,
				start: (dep) =>
					Effect.gen(function* () {
						yield* Ref.update(consumerStarts, (x) => x + 1);
						yield* Effect.addFinalizer(() => Ref.update(consumerFinalizers, (x) => x + 1));
						// Reads the *current* producer value each acquire.
						return { sawProducer: dep.token };
					}),
			});
			const independent = definePlugin({
				id: 'test:independent',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						yield* Ref.update(independentStarts, (x) => x + 1);
						yield* Effect.addFinalizer(() => Ref.update(independentFinalizers, (x) => x + 1));
						return { v: 'independent' as const };
					}),
			});

			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [consumer, producer, independent],
				options: {},
			};
			const state = yield* makeProjectionRef();

			const producerKey = pluginKey('test:producer#1');
			const consumerKey = pluginKey('test:consumer#0');
			const independentKey = pluginKey('test:independent#2');

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;

					// Initial acquire: each started once; consumer saw producer-1.
					yield* startup.handle.registry.awaitReady(producerKey);
					expect(yield* startup.handle.registry.awaitReady(consumerKey)).toEqual({
						sawProducer: 'producer-1',
					});
					yield* startup.handle.registry.awaitReady(independentKey);
					expect(yield* Ref.get(producerStarts)).toBe(1);
					expect(yield* Ref.get(consumerStarts)).toBe(1);
					expect(yield* Ref.get(independentStarts)).toBe(1);

					// Restart the producer; collect events until its
					// `restart.completed` lands (matches supervisor.test.ts).
					const seen = yield* Ref.make<ReadonlyArray<EngineEvent>>([]);
					yield* Queue.offer(startup.handle.commands, {
						tag: 'selective-restart.requested',
						pluginKey: producerKey,
					});
					while (true) {
						const event = yield* Queue.take(startup.handle.events);
						yield* Ref.update(seen, (prev) => [...prev, event]);
						if (
							event.tag === 'restart.completed' &&
							event.target !== 'stack' &&
							event.target.pluginKey === producerKey
						) {
							break;
						}
					}

					// Producer + its downstream (consumer) re-acquired exactly once more.
					expect(yield* Ref.get(producerStarts)).toBe(2);
					expect(yield* Ref.get(consumerStarts)).toBe(2);
					// Old producer + consumer scopes torn down (one finalizer each).
					expect(yield* Ref.get(producerFinalizers)).toBe(1);
					expect(yield* Ref.get(consumerFinalizers)).toBe(1);

					// The unrelated plugin was NOT touched.
					expect(yield* Ref.get(independentStarts)).toBe(1);
					expect(yield* Ref.get(independentFinalizers)).toBe(0);
					expect(yield* startup.handle.registry.getStatus(independentKey)).toBe('ready');

					// Downstream re-acquire observed the FRESH producer value.
					expect(yield* startup.handle.registry.awaitReady(consumerKey)).toEqual({
						sawProducer: 'producer-2',
					});
					expect(yield* startup.handle.registry.getStatus(producerKey)).toBe('ready');
					expect(yield* startup.handle.registry.getStatus(consumerKey)).toBe('ready');

					// restart.requested / restart.completed bracket the slice work.
					// The events queue still buffers the INITIAL-acquire transitions
					// (nothing drained it before the restart), so scope the isolation
					// check to events AFTER `restart.requested` — those are the ones
					// emitted DURING the restart, where the unrelated plugin must be
					// silent. (Its `start` not re-running is separately asserted above
					// via independentStarts === 1.)
					const events = yield* Ref.get(seen);
					const requestedIdx = events.findIndex((e) => e.tag === 'restart.requested');
					expect(requestedIdx).toBeGreaterThanOrEqual(0);
					expect(events.some((e) => e.tag === 'restart.completed')).toBe(true);
					const independentTransitions = events
						.slice(requestedIdx + 1)
						.filter(
							(e): e is Extract<EngineEvent, { readonly tag: 'lifecycle.statusChanged' }> =>
								e.tag === 'lifecycle.statusChanged' && e.pluginKey === independentKey,
						);
					expect(independentTransitions).toEqual([]);
				}),
			);
		}),
	);
});
