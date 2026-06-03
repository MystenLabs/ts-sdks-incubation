// Supervisor live `snapshot.restore` command path.
//
// The dashboard restore mutation routes through the command-loop via
// `submitCommand`, awaiting the real exit so it can report ok/detail.
// This file pins the CORRECTNESS of that path (separate from the
// snapshot orchestrator's own restore round-trip, covered by the e2e
// matrix + orchestrators/snapshot/restore.test.ts):
//
//   1. A FAILED restore handler (bad snapshot id, or a failure after the
//      on-disk swap) short-circuits — no drain/re-acquire runs and the
//      submitted command FAILS so the mutation reports `{ ok:false }`.
//   2. A valid restore whose re-acquire leaves a service `failed` (port
//      conflict / broken dep) FAILS the submitted command too — no green
//      dashboard with failed rows.
//   3. A successful restore re-acquires every drained service and the
//      submitted command SUCCEEDS, settling the cycle phase back to
//      `running`.
//   4. An empty re-acquire slice (every member carries
//      `keepAliveOnRestore`) still settles the `restoring` phase back to
//      `running` rather than sticking forever.

import { Context, Effect, Queue, Ref, SubscriptionRef } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import { appName, chainId, pluginKey, stackName } from '../../../../src/substrate/brand.ts';
import type { EngineCommand, EngineEvent } from '../../../../src/substrate/events.ts';
import type { Identity } from '../../../../src/substrate/identity.ts';
import {
	makeProjectionRef,
	startSupervisor,
	type SupervisedStack,
} from '../../../../src/substrate/runtime/index.ts';
import type { SupervisorCommandHandler } from '../../../../src/substrate/runtime/supervisor/state.ts';
import { definePlugin } from '../../../../src/substrate/plugin.ts';

const identity: Identity = {
	app: appName('snapshot-restore-test-app'),
	stack: stackName('main'),
	chain: chainId('test:local'),
};

// A command handler standing in for the injected snapshot L3 handler.
// Restore SUCCEEDS for `id:"good"` (emitting `snapshot.restored`) and
// FAILS for any other id (mirroring restoring a non-existent snapshot).
const makeRestoreHandler = (onRestore?: () => Effect.Effect<void>): SupervisorCommandHandler => {
	return (cmd) => {
		if (cmd.tag === 'snapshot.restore') {
			if (cmd.snapshotId !== 'good') {
				return Effect.fail(new Error(`unknown snapshot ${cmd.snapshotId}`));
			}
			return (onRestore?.() ?? Effect.void).pipe(
				Effect.as([{ tag: 'snapshot.restored', snapshotId: cmd.snapshotId, at: Date.now() }]),
			);
		}
		return Effect.succeed([]);
	};
};

const submitRestore = (
	handle: { readonly runCommand: (c: EngineCommand) => Effect.Effect<void, unknown> },
	id: string,
) => handle.runCommand({ tag: 'snapshot.restore', snapshotId: id }).pipe(Effect.exit);

describe('supervisor snapshot.restore command path', () => {
	it.effect('FAILS the submitted command and runs NO drain when the restore handler fails', () =>
		Effect.gen(function* () {
			const starts = yield* Ref.make(0);
			const svc = definePlugin({
				id: 'test:svc',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						const n = yield* Ref.updateAndGet(starts, (x) => x + 1);
						return { token: `svc-${n}` };
					}),
			});
			const stack: SupervisedStack = { _tag: 'Stack', members: [svc], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						Context.empty(),
						[],
						makeRestoreHandler(),
					);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:svc#0'));
					expect(yield* Ref.get(starts)).toBe(1);

					// Restore a snapshot that does not exist.
					const exit = yield* submitRestore(startup.handle, 'does-not-exist');

					// Submitted command FAILED (not ok:true).
					expect(exit._tag).toBe('Failure');
					// No drain + re-acquire ran: `start` body still ran exactly once.
					expect(yield* Ref.get(starts)).toBe(1);
					expect(yield* startup.handle.registry.getStatus(pluginKey('test:svc#0'))).toBe('ready');
				}),
			);
		}),
	);

	it.effect('FAILS the submitted command when the post-restore re-acquire leaves a row failed', () =>
		Effect.gen(function* () {
			// Succeeds on the INITIAL acquire, fails on every RE-acquire — so
			// the restore drain + re-acquire leaves it `failed`.
			const starts = yield* Ref.make(0);
			const flaky = definePlugin({
				id: 'test:flaky',
				role: 'service' as const,
				section: 'service',
				start: (): Effect.Effect<{ readonly ok: true }, 'reacquire-boom'> =>
					Effect.gen(function* () {
						const n = yield* Ref.updateAndGet(starts, (x) => x + 1);
						if (n > 1) return yield* Effect.fail('reacquire-boom' as const);
						return { ok: true as const };
					}),
			});
			const stack: SupervisedStack = { _tag: 'Stack', members: [flaky], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						Context.empty(),
						[],
						makeRestoreHandler(),
					);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:flaky#0'));

					const exit = yield* submitRestore(startup.handle, 'good');

					// Valid snapshot, but the re-acquire failed -> command FAILS.
					expect(exit._tag).toBe('Failure');
					// The flaky plugin is in fact `failed` after re-acquire.
					expect(yield* startup.handle.registry.getStatus(pluginKey('test:flaky#0'))).toBe(
						'failed',
					);
				}),
			);
		}),
	);

	it.effect('SUCCEEDS, re-acquiring every service and settling the phase to running', () =>
		Effect.gen(function* () {
			const starts = yield* Ref.make(0);
			const svc = definePlugin({
				id: 'test:svc',
				role: 'service' as const,
				section: 'service',
				start: () =>
					Effect.gen(function* () {
						const n = yield* Ref.updateAndGet(starts, (x) => x + 1);
						return { token: `svc-${n}` };
					}),
			});
			const stack: SupervisedStack = { _tag: 'Stack', members: [svc], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						Context.empty(),
						[],
						makeRestoreHandler(),
					);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:svc#0'));
					expect(yield* Ref.get(starts)).toBe(1);

					const exit = yield* submitRestore(startup.handle, 'good');

					expect(exit._tag).toBe('Success');
					// Service was drained + re-acquired (start ran a second time).
					expect(yield* Ref.get(starts)).toBe(2);
					expect(yield* startup.handle.registry.getStatus(pluginKey('test:svc#0'))).toBe('ready');
					// Phase settled back to `running`.
					expect((yield* SubscriptionRef.get(state)).cycle.phase).toBe('running');
				}),
			);
		}),
	);

	it.effect('settles the restoring phase to running on an EMPTY re-acquire slice', () =>
		Effect.gen(function* () {
			// The stack's only member is kept alive on restore -> the drain
			// slice is empty -> `doSelectiveRestart` emits no restart events.
			const starts = yield* Ref.make(0);
			const keepAlive = definePlugin({
				id: 'test:transport',
				role: 'service' as const,
				section: 'service',
				keepAliveOnRestore: true,
				start: () =>
					Effect.gen(function* () {
						yield* Ref.update(starts, (x) => x + 1);
						return { transport: true as const };
					}),
			});
			const stack: SupervisedStack = { _tag: 'Stack', members: [keepAlive], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						Context.empty(),
						[],
						makeRestoreHandler(),
					);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:transport#0'));
					expect(yield* Ref.get(starts)).toBe(1);

					const exit = yield* submitRestore(startup.handle, 'good');

					expect(exit._tag).toBe('Success');
					// Empty slice -> the kept-alive member was NOT re-acquired.
					expect(yield* Ref.get(starts)).toBe(1);
					// Phase did NOT stick at `restoring`.
					expect((yield* SubscriptionRef.get(state)).cycle.phase).toBe('running');
				}),
			);
		}),
	);

	it.effect('emits restart.completed (settle) without restart.requested on an empty slice', () =>
		Effect.gen(function* () {
			const keepAlive = definePlugin({
				id: 'test:transport',
				role: 'service' as const,
				section: 'service',
				keepAliveOnRestore: true,
				start: () => Effect.succeed({ transport: true as const }),
			});
			const stack: SupervisedStack = { _tag: 'Stack', members: [keepAlive], options: {} };
			const state = yield* makeProjectionRef();

			yield* Effect.scoped(
				Effect.gen(function* () {
					const startup = yield* startSupervisor(
						stack,
						identity,
						state,
						Context.empty(),
						[],
						makeRestoreHandler(),
					);
					yield* startup.runInitialAcquire;
					yield* startup.handle.registry.awaitReady(pluginKey('test:transport#0'));

					// The restore completes synchronously w.r.t. the submitted
					// command; its events buffer in the unbounded queue. Submit,
					// then drain up to the settle (`restart.completed`).
					const exit = yield* submitRestore(startup.handle, 'good');
					expect(exit._tag).toBe('Success');

					const seen: Array<EngineEvent> = [];
					while (true) {
						const event = yield* Queue.take(startup.handle.events);
						seen.push(event);
						if (event.tag === 'restart.completed') break;
					}
					expect(seen.some((e) => e.tag === 'snapshot.restored')).toBe(true);
					expect(seen.some((e) => e.tag === 'restart.completed')).toBe(true);
					// No per-root restart.requested fired (empty slice).
					expect(seen.some((e) => e.tag === 'restart.requested')).toBe(false);
				}),
			);
		}),
	);
});
