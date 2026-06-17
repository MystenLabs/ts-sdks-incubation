// One-shot supervise readiness-gate — the proof for S5.
//
// The one-shot supervise path (`superviseStackEffect` with
// `lifetime: 'one-shot'`) used to re-gate readiness AFTER
// `runInitialAcquire` with a per-node `awaitAll` fan-out — the same
// `registry.awaitReady(key)` watcher S1 removed from the long-running
// path. `awaitReady` suspends on a node's `readyGate`, which is ONLY
// resolved by `markReady` / `markFailed`. A run-to-completion `task`
// node lands in `done` (terminal-ready by the status contract), but the
// registry contract admits a `done`-status node whose `readyGate` is
// unresolved — so a per-node gate HANGS on it.
//
// S5 routes the one-shot gate through the SUPERVISOR-OWNED signal
// (`allReadyOrTerminal` — `ready || done`), the same `done`-tolerant gate
// the long-running path uses. This test pins that a one-shot supervise of
// a stack with a `ready` leaf + a `done` (`role: 'task'`) plugin
// COMPLETES rather than hanging. A regression that reintroduces the
// per-node `awaitReady` fan-out would time out here.
//
// Docker-free: the leaf/task plugins touch no daemon — the substrate
// Layer stack builds without a container runtime call, and the one-shot
// path runs no post-acquire codegen hook.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import { definePlugin } from '../../src/api/define-plugin.ts';
import { appName, stackName } from '../../src/substrate/brand.ts';
import type { Identity } from '../../src/substrate/identity.ts';
import { buildSubstrateLayers, superviseStackEffect } from '../../src/orchestrators/boot.ts';
import { makeProjectionRef } from '../../src/substrate/runtime/projection/state-ref.ts';
import { resolveGraph } from '../../src/substrate/runtime/lifecycle/index.ts';
import { buildRegistry } from '../../src/substrate/runtime/supervisor/acquire-node.ts';
import { allReadyOrTerminal } from '../../src/substrate/runtime/supervisor/state.ts';

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'one-shot-gate-test-'));

const identity: Identity = {
	app: appName('one-shot-gate'),
	stack: stackName('main'),
	network: 'local',
};

describe('orchestrators/boot one-shot readiness gate', () => {
	// ── The CONTRACT-boundary divergence the one-shot gate now tolerates ──
	//
	// Drive a single node to `done` via the registry's own `transition`
	// API (`pending → acquiring → ready → done`) — which mutates the status
	// Ref ONLY and never resolves the `readyGate`. The node is `done`
	// (terminal-ready by the status contract) yet its `awaitReady` gate
	// stays unresolved: the EXACT shape the supervisor's
	// `allReadyOrTerminal` admits but the OLD one-shot per-node `awaitAll`
	// fan-out could not survive. This is the gate S5 switched the one-shot
	// path onto; reading statuses never suspends, so it is hang-free.
	it('allReadyOrTerminal resolves on a done node whose readyGate is unresolved; awaitReady hangs', async () => {
		const task = definePlugin({
			id: 'test/one-shot-done-task-unit',
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

					// Supervisor-owned status gate (what the one-shot path now
					// uses): satisfied.
					const statusGate = yield* allReadyOrTerminal(graph, registry);

					// Per-node ready-gate (the OLD one-shot `awaitAll` fan-out):
					// hangs — bound it with a timeout so the suspended fiber
					// surfaces as a `None` rather than wedging the test.
					const perNodeGate = yield* registry
						.awaitReady(key)
						.pipe(Effect.timeoutOption('1 second'));

					return { statusGate, perNodeGateResolved: perNodeGate._tag === 'Some' };
				}),
			),
		);

		// Status gate (what the one-shot path now uses) completes.
		expect(result.statusGate).toBe(true);
		// Per-node `awaitReady` gate (what the one-shot path used to fan out
		// over) does NOT — it times out. This is the hang S5 removes.
		expect(result.perNodeGateResolved).toBe(false);
	}, 15_000);

	// A stack with a normal `ready` leaf + a `done` run-to-completion
	// (`role: 'task'`) plugin. A one-shot supervise must COMPLETE through
	// the supervisor-owned `allReadyOrTerminal` gate. Generous timeout: a
	// regression that reintroduces the per-node `awaitReady` fan-out (whose
	// `done`-node gate need not resolve) would time out here.
	it('one-shot supervise completes for a stack with a ready leaf + a done (task) plugin', async () => {
		const leaf = definePlugin({
			id: 'test/one-shot-gate-leaf',
			role: 'service' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const runToCompletion = definePlugin({
			id: 'test/one-shot-gate-done-task',
			role: 'task' as const,
			section: 'service',
			start: () => Effect.succeed({ done: true } as const),
		});

		const runtimeRoot = makeRuntimeRoot();
		try {
			const exit = await Effect.runPromise(
				Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const state = yield* makeProjectionRef();
							yield* superviseStackEffect(
								{ _tag: 'Stack', members: [leaf, runToCompletion], options: {} },
								identity,
								state,
								{ lifetime: 'one-shot' },
							);
						}),
					)
						.pipe(Effect.provide(buildSubstrateLayers(identity, runtimeRoot)))
						.pipe(Effect.timeout('10 seconds')),
				),
			);
			expect(Exit.isSuccess(exit)).toBe(true);
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
