// `runStack` readiness-gate equivalence — the proof for S1.
//
// runStack used to gate "boot complete" by forking a per-node watcher
// that called `registry.awaitReady(key)` for every node. `awaitReady`
// suspends on the node's `readyGate`, which is ONLY resolved by
// `markReady` (success) or `markFailed` (failure). The supervisor's own
// readiness signal — `runInitialAcquire` → `allReadyOrTerminal` — instead
// gates on the STATUS contract `isReadyOrTerminal` (`ready || done`). The
// two gates diverge on a non-failed terminal `done` node: its STATUS is
// terminal-ready, but its `readyGate` need not be resolved. A per-node
// `awaitReady` watcher therefore HANGS on such a node, while the
// supervisor's status gate completes.
//
// S1 routes runStack's boot gate through the supervisor-owned signal
// (`superviseStackEffect`'s `withinScope`, which fires only after
// `runInitialAcquire` wins the `raceFirst`). These tests pin:
//
//   1. The DIRECT gate divergence at the registry contract boundary:
//      `allReadyOrTerminal` resolves on a `done`-status node whose
//      `readyGate` is unresolved, while `awaitReady` on the same node
//      times out. This is exactly the hang the old runStack gate
//      inherited.
//   2. End-to-end: a stack with a `ready` leaf + a `done` run-to-
//      completion (`role: 'task'`) plugin → `handle.start` RESOLVES.
//   3. A plugin that FAILS during initial acquire → `handle.start`
//      fails with `BootError` (the fail path still works).
//
// All Docker-free: the leaf/task/failing plugins touch no daemon — the
// substrate Layer stack builds without a container runtime call.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import { runStack } from '../../src/api/run-stack.ts';
import { resolveGraph } from '../../src/substrate/runtime/lifecycle/index.ts';
import { buildRegistry } from '../../src/substrate/runtime/supervisor/acquire-node.ts';
import { allReadyOrTerminal } from '../../src/substrate/runtime/supervisor/state.ts';

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'run-stack-gate-test-'));

describe('api/run-stack readiness gate', () => {
	// ── 1. The DIRECT divergence at the registry contract boundary ──────
	//
	// Drive a single node to `done` via the registry's own `transition`
	// API (`pending → acquiring → ready → done`). `transition` mutates the
	// status Ref ONLY — it never resolves the `readyGate` (only `markReady`
	// / `markFailed` do). So the node is `done` (terminal-ready by the
	// status contract) yet its `awaitReady` gate stays unresolved — the
	// EXACT shape the supervisor's `isReadyOrTerminal` admits but the old
	// per-node `awaitReady` watcher could not survive.
	it('allReadyOrTerminal resolves on a done node whose readyGate is unresolved; awaitReady hangs', async () => {
		const task = definePlugin({
			id: 'test/done-task-unit',
			role: 'task' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const graph = yield* resolveGraph([task]);
					const registry = yield* buildRegistry(graph, scope, () => Effect.void);
					const key = [...graph.nodes.keys()][0];
					if (key === undefined) throw new Error('expected one node');

					// pending → acquiring → ready → done, all via `transition`,
					// so the readyGate is NEVER resolved.
					yield* registry.transition(key, 'acquiring');
					yield* registry.transition(key, 'ready');
					yield* registry.transition(key, 'done');
					expect(yield* registry.getStatus(key)).toBe('done');

					// Supervisor-owned status gate: satisfied.
					const statusGate = yield* allReadyOrTerminal(graph, registry);

					// Per-node ready-gate (the OLD runStack gate): hangs — bound
					// it with a timeout so the suspended fiber surfaces as a
					// `None` rather than wedging the test.
					const perNodeGate = yield* registry
						.awaitReady(key)
						.pipe(Effect.timeoutOption('1 second'));

					return { statusGate, perNodeGateResolved: perNodeGate._tag === 'Some' };
				}),
			),
		);

		// Status gate (what runStack now uses) completes.
		expect(result.statusGate).toBe(true);
		// Per-node `awaitReady` gate (what runStack used to fork) does NOT
		// — it times out. This is the hang S1 removes.
		expect(result.perNodeGateResolved).toBe(false);
	}, 15_000);

	// ── 2. End-to-end regression gate ───────────────────────────────────
	//
	// A stack with a normal `ready` leaf + a `done` run-to-completion
	// plugin. `handle.start` must RESOLVE through the supervisor-owned
	// gate. Generous timeout: a regression that reintroduces a per-node
	// `awaitReady` watcher (whose `done`-node gate need not resolve) would
	// time out here.
	it('start resolves for a stack with a ready leaf + a done (task) plugin', async () => {
		const leaf = definePlugin({
			id: 'test/gate-leaf',
			role: 'service' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const runToCompletion = definePlugin({
			id: 'test/gate-done-task',
			role: 'task' as const,
			section: 'service',
			start: () => Effect.succeed({ done: true } as const),
		});

		const stack = defineDevstack({ members: [leaf, runToCompletion], stackName: 'main' });
		const runtimeRoot = makeRuntimeRoot();
		const handle = runStack(stack, {
			identity: { app: 'run-stack-gate-done', stack: 'main', network: 'localnet' },
			runtimeRoot,
		});

		try {
			const exit = await Effect.runPromise(
				Effect.exit(handle.start.pipe(Effect.timeout('10 seconds'))),
			);
			expect(Exit.isSuccess(exit)).toBe(true);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	// ── 3. The fail path still works ────────────────────────────────────
	it('start fails with BootError when a plugin fails during initial acquire', async () => {
		const failing = definePlugin({
			id: 'test/gate-failing-acquire',
			role: 'service' as const,
			section: 'service',
			start: () =>
				Effect.fail(new Error('intentional acquire failure')).pipe(
					Effect.as({ ok: false } as const),
				),
		});

		const stack = defineDevstack({ members: [failing], stackName: 'main' });
		const runtimeRoot = makeRuntimeRoot();
		const handle = runStack(stack, {
			identity: { app: 'run-stack-gate-fail', stack: 'main', network: 'localnet' },
			runtimeRoot,
		});

		try {
			const exit = await Effect.runPromise(Effect.exit(handle.start));
			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
			expect(error?._tag === 'Some' && error.value._tag).toBe('BootError');
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
