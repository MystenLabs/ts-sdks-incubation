// `runStackWithBoot` boot-injection seam — the S2 contract.
//
// `runStack` is now a thin facade over the NON-PUBLIC `runStackWithBoot`,
// which threads a caller-injected `boot` bag (`beforeInitialAcquire` /
// `withinScope`) the CLI `up` verb routes through in S3. These tests pin
// the two load-bearing properties of that seam:
//
//   1. HOOK ORDER (the PR#21 boot-ordering regression gate). The composed
//      hooks run the BUILT-IN work FIRST, then the caller's:
//        beforeInitialAcquire: built-in handoff/stop-bridge/command-pump →
//          caller beforeInitialAcquire → FIRST ACQUIRE side effect.
//        withinScope: built-in readiness-gate resolution → caller
//          withinScope (so warm-capture can never delay `handle.start`).
//      Proven two ways: (a) a shared label Ref records
//      `caller-before → plugin-acquire → caller-within` in that exact
//      order; (b) inside the caller `beforeInitialAcquire`, a command
//      offered onto the PUBLIC `commands` queue is already delivered to the
//      supervisor's own queue — i.e. the built-in command-pump was armed
//      BEFORE the caller hook ran.
//
//   2. ROSTER → EXIT-40. A caller `boot.beforeInitialAcquire` that fails
//      with `CliSupervisorLiveError` (constructed exactly as the CLI does)
//      surfaces as `BootError` on `handle.start`, and
//      `findCliSupervisorLiveError(cause)` extracts the live error — the
//      seam preserves the CLI's exit-40 contract.
//
// Plus a TYPE-LEVEL assertion that the zero-`boot` `runStack(...)` handle's
// `start` is `Effect<void, BootError, never>` — the public error channel
// did NOT widen when the caller bag hooks (which return
// `Effect<void, unknown>`) fold into `BootError`.
//
// All Docker-free: the leaf plugin touches no daemon.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import { runStack, type BootError, type RunHandle } from '../../src/api/run-stack.ts';
import { runStackWithBoot } from '../../src/api/run-stack-internal.ts';
import { findCliSupervisorLiveError } from '../../src/cli/wirings/identity.ts';
import { CliSupervisorLiveError } from '../../src/surfaces/cli/index.ts';

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'run-stack-boot-bag-'));

describe('runStackWithBoot boot-injection seam', () => {
	// ── 1. HOOK ORDER (PR#21 regression gate) ───────────────────────────
	it('composes built-in → caller for beforeInitialAcquire and withinScope', async () => {
		const order: string[] = [];
		const runtimeRoot = makeRuntimeRoot();

		// The leaf plugin's `start` IS the first-acquire side effect. It
		// pushes `plugin-acquire`, so its position relative to the caller
		// hooks pins the composition order.
		const leaf = definePlugin({
			id: 'test/boot-bag-leaf',
			role: 'service' as const,
			section: 'service',
			start: () =>
				Effect.sync(() => {
					order.push('plugin-acquire');
					return { ok: true } as const;
				}),
		});

		const stack = defineDevstack({ members: [leaf], stackName: 'main' });

		// Captured outside so the assertion can read the delivery proof: the
		// built-in `beforeInitialAcquire` work (run FIRST in the composed
		// hook) resolves the public submit-and-await dispatch and forks the
		// command-pump onto the supervisor's own queue. We prove both are
		// already live when the caller hook runs by issuing a benign no-op
		// `stack.start` through `h.runCommand` (submit-and-await): it can
		// only complete if the built-in handoff resolved the dispatch
		// deferred AND the supervisor command loop is draining — i.e. the
		// built-in work ran BEFORE this caller hook.
		let builtInDispatchReady = false;

		const handle = runStackWithBoot(stack, {
			identity: { app: 'run-stack-boot-bag-order', stack: 'main', network: 'localnet' },
			runtimeRoot,
			boot: {
				beforeInitialAcquire: (h) =>
					Effect.gen(function* () {
						order.push('caller-before');
						const dispatched = yield* h
							.runCommand({ tag: 'stack.start' })
							.pipe(Effect.timeoutOption('3 seconds'), Effect.catch(() => Effect.succeedNone));
						builtInDispatchReady = dispatched._tag === 'Some';
					}),
				withinScope: () =>
					Effect.sync(() => {
						order.push('caller-within');
					}),
			},
		});

		try {
			const exit = await Effect.runPromise(
				Effect.exit(handle.start.pipe(Effect.timeout('10 seconds'))),
			);
			expect(Exit.isSuccess(exit)).toBe(true);

			// caller-before ran in beforeInitialAcquire → BEFORE first acquire.
			// caller-within ran in withinScope → AFTER first acquire. Exact
			// order pins the composition.
			expect(order).toEqual(['caller-before', 'plugin-acquire', 'caller-within']);

			// Built-in handoff (dispatch deferred + command loop) was live
			// BEFORE the caller beforeInitialAcquire hook ran.
			expect(builtInDispatchReady).toBe(true);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	// ── 2. ROSTER → EXIT-40 (CLI contract through the seam) ─────────────
	it('a caller beforeInitialAcquire failing with CliSupervisorLiveError surfaces as BootError carrying the live error', async () => {
		const runtimeRoot = makeRuntimeRoot();
		const leaf = definePlugin({
			id: 'test/boot-bag-roster-leaf',
			role: 'service' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });

		const handle = runStackWithBoot(stack, {
			identity: { app: 'run-stack-boot-bag-roster', stack: 'main', network: 'localnet' },
			runtimeRoot,
			boot: {
				// Mirror `installLiveSupervisorRoster`: refuse boot with the
				// exact error the CLI raises on a sole-holder loss.
				beforeInitialAcquire: () =>
					Effect.fail(
						new CliSupervisorLiveError({
							app: 'run-stack-boot-bag-roster',
							stack: 'main',
							hint: 'use `devstack apply` from another shell, or choose a different --stack name',
						}),
					),
			},
		});

		try {
			const exit = await Effect.runPromise(Effect.exit(handle.start));
			expect(Exit.isFailure(exit)).toBe(true);

			const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
			// start's error channel stays BootError.
			expect(error?._tag === 'Some' && error.value._tag).toBe('BootError');

			// The CLI's exit-40 extractor pulls the live error back out of the
			// BootError's cause — the contract S3 relies on.
			const bootError =
				error?._tag === 'Some' ? (error.value as BootError) : undefined;
			const live =
				bootError !== undefined ? findCliSupervisorLiveError(bootError.cause) : null;
			expect(live).not.toBeNull();
			expect(live?._tag).toBe('CliSupervisorLiveError');
			expect(live?.app).toBe('run-stack-boot-bag-roster');
			expect(live?.stack).toBe('main');
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	// ── 3. TYPE-LEVEL: public error channel did NOT widen ───────────────
	it('zero-boot runStack handle.start is Effect<void, BootError, never>', () => {
		const stack = defineDevstack({
			members: [
				definePlugin({
					id: 'test/boot-bag-type-leaf',
					role: 'service' as const,
					section: 'service',
					start: () => Effect.succeed({ ok: true } as const),
				}),
			],
			stackName: 'main',
		});
		const handle: RunHandle = runStack(stack, {
			identity: { app: 'run-stack-boot-bag-type', stack: 'main', network: 'localnet' },
		});
		// Compile-time pin: `start` is exactly `Effect<void, BootError, never>`.
		// If the caller bag hooks (which return `Effect<void, unknown>`) ever
		// widened the public error channel, this `satisfies` would fail to
		// compile.
		const start = handle.start satisfies Effect.Effect<void, BootError, never>;
		expect(typeof start).toBe('object');
	});
});
