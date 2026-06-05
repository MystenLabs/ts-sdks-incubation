// Supervisor acquire / teardown orchestration.
//
// `supervisor-hard-shutdown.test.ts` pins the *interrupt* invariant (the
// uninterruptible wrap around the in-loop teardown). This file
// complements it by pinning the *data-flow* invariants of the per-node
// acquire pipeline and the reverse-dep teardown ordering, driven through
// the public `startSupervisor` entry point with real (tiny) plugins:
//
//   1. happy-path dependency graph — acquires in dep order, upstream
//      resolved values flow into downstream `start(deps)`.
//   2. partial-failure rollback — an upstream `start` failing causes the
//      downstream to be skipped (never acquired) while already-acquired
//      upstream finalizers still run on scope close.
//   3. task-role `done` transition — a `task` plugin lands on `done`
//      (not `ready`) after `markReady`.
//   4. teardown order — on scope close, plugin finalizers run in
//      reverse-dependency order.

import { Effect, Ref } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, pluginKey, stackName } from '../../../../src/substrate/brand.ts';
import type { Identity } from '../../../../src/substrate/identity.ts';
import {
	makeProjectionRef,
	startSupervisor,
	type SupervisedStack,
} from '../../../../src/substrate/runtime/index.ts';
import { definePlugin } from '../../../../src/substrate/plugin.ts';

const identity: Identity = {
	app: appName('acquire-teardown-test-app'),
	stack: stackName('main'),
	chain: 'test:local',
};

describe('supervisor acquire pipeline', () => {
	it.effect('acquires a dep graph in order and flows resolved values to dependents', () =>
		Effect.gen(function* () {
			// Order of `start` body entry, captured as plugins acquire.
			const startOrder = yield* Ref.make<ReadonlyArray<string>>([]);
			const recordStart = (id: string) => Ref.update(startOrder, (prev) => [...prev, id]);

			// base -> mid -> leaf. Each upstream resolves a value the
			// downstream reads from its `deps`.
			const base = definePlugin({
				id: 'test:base',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						yield* recordStart('base');
						return { token: 'base-token' as const };
					}),
			});
			const mid = definePlugin({
				id: 'test:mid',
				role: 'service' as const,
				section: 'service',
				dependsOn: base,
				start: (dep) =>
					Effect.gen(function* () {
						yield* recordStart('mid');
						// Upstream resolved value flows in.
						expect(dep).toEqual({ token: 'base-token' });
						return { from: dep.token, mid: 'mid-token' as const };
					}),
			});
			const leaf = definePlugin({
				id: 'test:leaf',
				role: 'service' as const,
				section: 'service',
				dependsOn: mid,
				start: (dep) =>
					Effect.gen(function* () {
						yield* recordStart('leaf');
						expect(dep).toEqual({ from: 'base-token', mid: 'mid-token' });
						return { ok: true as const };
					}),
			});

			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [leaf, mid, base],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;

					// All three reach ready (resolved value returned).
					expect(yield* startup.handle.registry.awaitReady(pluginKey('test:base#2'))).toEqual({
						token: 'base-token',
					});
					expect(yield* startup.handle.registry.awaitReady(pluginKey('test:mid#1'))).toEqual({
						from: 'base-token',
						mid: 'mid-token',
					});
					expect(yield* startup.handle.registry.awaitReady(pluginKey('test:leaf#0'))).toEqual({
						ok: true,
					});

					// Dependency-respecting acquire: base before mid before leaf.
					const order = yield* Ref.get(startOrder);
					expect(order.indexOf('base')).toBeLessThan(order.indexOf('mid'));
					expect(order.indexOf('mid')).toBeLessThan(order.indexOf('leaf'));
				}),
			);
		}),
	);

	it.effect('skips downstream and tears down acquired upstreams when an upstream fails', () =>
		Effect.gen(function* () {
			const upstreamFinalizerRan = yield* Ref.make(false);
			const downstreamStarted = yield* Ref.make(false);

			// An already-acquired sibling/upstream whose finalizer MUST run
			// on scope close even though a different upstream fails.
			const okUpstream = definePlugin({
				id: 'test:ok-upstream',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() => Ref.set(upstreamFinalizerRan, true));
						return { ok: true as const };
					}),
			});
			const failingUpstream = definePlugin({
				id: 'test:failing-upstream',
				role: 'service' as const,
				section: 'service',
				// Explicit success type so the plugin's value generic isn't
				// `never` — that would break `AnyPlugin` capabilities-factory
				// variance when this plugin sits in a mixed `members` array.
				start: (): Effect.Effect<{ readonly unreached: true }, 'boom'> =>
					Effect.fail('boom' as const),
			});
			// Depends on both — the failing one blocks its acquire.
			const downstream = definePlugin({
				id: 'test:downstream',
				role: 'service' as const,
				section: 'service',
				dependsOn: [okUpstream, failingUpstream] as const,
				start: () =>
					Effect.gen(function* () {
						yield* Ref.set(downstreamStarted, true);
						return { reached: true as const };
					}),
			});

			const stack: SupervisedStack = {
				_tag: 'Stack',
				members: [downstream, okUpstream, failingUpstream],
				options: {},
			};
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;

					// Failing upstream landed on `failed`.
					expect(
						yield* startup.handle.registry.getStatus(pluginKey('test:failing-upstream#2')),
					).toBe('failed');
					// Healthy upstream still reached `ready`.
					expect(yield* startup.handle.registry.getStatus(pluginKey('test:ok-upstream#1'))).toBe(
						'ready',
					);
					// Downstream `start` body NEVER ran (skipped on upstream fail).
					expect(yield* Ref.get(downstreamStarted)).toBe(false);
					// acquireNode's upstream-wait branch marks the skipped node
					// `failed` (pending → failed is on-table) so its ready gate
					// fails and its own downstream short-circuits in turn.
					expect(yield* startup.handle.registry.getStatus(pluginKey('test:downstream#0'))).toBe(
						'failed',
					);
				}),
			);

			// Scope closed -> acquired upstream's finalizer ran (rollback).
			expect(yield* Ref.get(upstreamFinalizerRan)).toBe(true);
		}),
	);

	it.effect('task-role plugin transitions to `done` after markReady', () =>
		Effect.gen(function* () {
			const task = definePlugin({
				id: 'test:one-shot',
				role: 'task' as const,
				section: 'service',
				start: () => Effect.succeed({ ran: true as const }),
			});
			const stack: SupervisedStack = { _tag: 'Stack', members: [task], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;
					// The readyGate resolves (markReady), then the task hops to `done`.
					yield* startup.handle.registry.awaitReady(pluginKey('test:one-shot#0'));
					expect(yield* startup.handle.registry.getStatus(pluginKey('test:one-shot#0'))).toBe(
						'done',
					);
				}),
			);
		}),
	);

	it.effect('tears plugins down in reverse-dependency order on scope close', () =>
		Effect.gen(function* () {
			const teardownOrder = yield* Ref.make<ReadonlyArray<string>>([]);
			const recordTeardown = (id: string) => Ref.update(teardownOrder, (prev) => [...prev, id]);

			const base = definePlugin({
				id: 'test:td-base',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() => recordTeardown('base'));
						return { v: 'base' as const };
					}),
			});
			const leaf = definePlugin({
				id: 'test:td-leaf',
				role: 'service' as const,
				section: 'service',
				dependsOn: base,
				start: () =>
					Effect.gen(function* () {
						yield* Effect.addFinalizer(() => recordTeardown('leaf'));
						return { v: 'leaf' as const };
					}),
			});

			const stack: SupervisedStack = { _tag: 'Stack', members: [leaf, base], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(stack, identity, state);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:td-base#1'));
					yield* startup.handle.registry.awaitReady(pluginKey('test:td-leaf#0'));
				}),
			);

			// Reverse-dep teardown: leaf (downstream) finalizes before base.
			const order = yield* Ref.get(teardownOrder);
			expect(order).toEqual(['leaf', 'base']);
		}),
	);
});
