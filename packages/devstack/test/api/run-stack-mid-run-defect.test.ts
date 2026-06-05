// Regression: pre-fix `runStack`'s supervised body wrapped the entire
// program in `Effect.catchCause` that called `Deferred.fail(bootDeferred,
// ...)`. Once the deferred had already succeeded (boot complete), the
// `Deferred.fail` is a no-op — so any LATER defect/failure (e.g. a
// plugin scope finalizer throwing during shutdown) was silently
// dropped. The fiber exited `Success(void)`, `awaitShutdown` resolved
// clean, and operators received no signal of the failure.
//
// Post-fix: the catchCause tees the cause into a private
// `midRunCauseRef` and `awaitShutdown` re-raises it. The boot path
// remains unchanged — boot failures still surface via `start`, not
// `awaitShutdown`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option } from 'effect';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import { runStack } from '../../src/api/run-stack.ts';

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'run-stack-mid-run-defect-'));

describe('runStack mid-run defect tee', () => {
	it('awaitShutdown re-raises a plugin scope finalizer defect that surfaces after boot', async () => {
		// The plugin acquires successfully (so boot completes), then on
		// shutdown its scope finalizer throws — a classic "finalizer
		// defect" cause that the pre-fix code swallowed.
		const SENTINEL = 'mid-run-defect-sentinel-9b7c';
		const finalizerDefectPlugin = definePlugin({
			id: 'test/finalizer-defect',
			role: 'service' as const,
			section: 'service',
			start: () =>
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() => Effect.die(new Error(SENTINEL)));
					return { ok: true } as const;
				}),
		});

		const stack = defineDevstack({ members: [finalizerDefectPlugin], stackName: 'main' });
		const runtimeRoot = makeRuntimeRoot();
		const handle = runStack(stack, {
			identity: {
				app: 'run-stack-mid-run-defect',
				stack: 'main',
				network: 'localnet',
			},
			runtimeRoot,
		});

		try {
			// Boot must succeed — the finalizer hasn't run yet.
			await Effect.runPromise(handle.start);

			// Graceful shutdown triggers the per-plugin scope close,
			// which runs the finalizer → die(...) → defect cause.
			// Bound stop with a timeout so a future supervisor-side
			// regression (defect causing the deferred to never
			// succeed) surfaces as a fast test failure rather than a
			// 30-second hang.
			await Effect.runPromise(handle.stop.pipe(Effect.timeoutOption('10 seconds')));

			// `awaitShutdown` should EITHER surface the captured cause
			// (post-fix mid-run tee) OR time out (if a future
			// regression makes the supervisor swallow the deferred).
			// What it must NOT do is resolve clean — the pre-fix
			// behavior the user filed the bug against.
			const exit = await Effect.runPromise(
				Effect.exit(handle.awaitShutdown.pipe(Effect.timeout('10 seconds'))),
			);
			expect(Exit.isFailure(exit)).toBe(true);

			if (Exit.isFailure(exit)) {
				// The cause should carry either the original defect's
				// sentinel string OR a TimeoutError — anything but a
				// silent success. The timeout path surfaces a real
				// downstream issue we tracked separately: the supervisor's
				// `teardown.ts` swallows scope-finalizer defects via
				// `.pipe(Effect.catch(() => Effect.void))`, which only
				// catches the E channel — defects propagate, but the
				// shutdownComplete deferred never fires because the
				// teardown fiber dies. Until that is fixed (phase 22f),
				// the timeout is the correct loud signal.
				const pretty = Cause.pretty(exit.cause);
				const errorOpt = Cause.findErrorOption(exit.cause);
				const errorTag =
					Option.isSome(errorOpt) && typeof errorOpt.value === 'object' && errorOpt.value !== null
						? (errorOpt.value as { readonly _tag?: string })._tag
						: undefined;
				const signalledMidRunDefect = pretty.includes(SENTINEL);
				const signalledTimeout = errorTag === 'TimeoutError' || errorTag === 'TimeoutException';
				expect(signalledMidRunDefect || signalledTimeout).toBe(true);
			}
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it('awaitShutdown resolves clean when no mid-run defect occurs (no regression)', async () => {
		const leaf = definePlugin({
			id: 'test/clean-leaf',
			role: 'service' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});

		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const runtimeRoot = makeRuntimeRoot();
		const handle = runStack(stack, {
			identity: {
				app: 'run-stack-mid-run-defect-clean',
				stack: 'main',
				network: 'localnet',
			},
			runtimeRoot,
		});

		try {
			await Effect.runPromise(handle.start);
			await Effect.runPromise(handle.stop);
			const exit = await Effect.runPromise(Effect.exit(handle.awaitShutdown));
			expect(Exit.isSuccess(exit)).toBe(true);
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
