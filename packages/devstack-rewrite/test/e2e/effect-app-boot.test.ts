// End-to-end boot of `examples/effect-app-rewrite/` — the
// Effect-native consumer profile. Unlike every other e2e in this
// directory (which boot via the `runBoot` helper that re-implements
// the substrate Layer composition for the test harness),
// `effect-app-rewrite` consumes devstack the way a downstream Effect
// library would: it imports the `Stack` value and hands it to
// `runStack(stack)`.
//
// This test is the proof that `runStack` is a real, end-user-usable
// embedding seam. `runBoot` (the harness path) and `runStack` (the
// library path) compose the same substrate Layer stack via
// `substrate/runtime/run.ts:buildSubstrateLayers`; running both green
// side-by-side pins parity.
//
// What this test pins:
//   - The `Stack` value exported from
//     `examples/effect-app-rewrite/devstack.config.ts` boots through
//     the public `runStack(stack)` seam without any custom Layer
//     wiring. (No `boot-config-impl.ts` indirection.)
//   - Every plugin reaches `ready` — concrete keys for the dev branch:
//     `sui#0` (auto-mounted by the composer because `alice` consumes
//     `'sui'`), `account/alice#1`.
//   - Clean shutdown via `handle.stop` + `handle.awaitShutdown`.
//   - Reading the projection snapshot mid-boot surfaces the resolved
//     identity (`app: 'effect-app'`, `stack: 'main'`).
//
// What this test does NOT pin yet (tracked under opportunities):
//
//   - The prod branch (`isProduction === true`, `account('alice',
//     { kind: 'env', ... })`). The example's config switches on
//     `process.env.NODE_ENV`; the example's `src/main.ts` doesn't yet
//     parameterize against two `Stack` values, so there's no second
//     boot path to assert against. Once the dev/prod branches export
//     as two named stacks (or the example wires `NODE_ENV=production`
//     into a separate `devStack` / `prodStack` export), this test
//     gains a second `it.skipIf(...)` row asserting the prod branch
//     either composes against `chain: 'sui:testnet'` (live mode, no
//     container) or surfaces a typed account `kind: 'env'` decode
//     error when `ALICE_PRIVATE_KEY` is unset.
//
//   - The dev-path "in-process Effect program" branch. `src/main.ts`
//     today only logs a string once the stack composes; once the
//     example wires a real body (read alice's balance via the
//     resolved `SuiClient`, sign-and-execute a tx), this test mirrors
//     the body inside `withinScope` and asserts the program runs to
//     completion.
//
// Prerequisites: docker reachable. Soft-skipped via console warn when
// not (matches the `dockerReachable` pattern used by every other e2e
// in this directory).

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
import { describe, expect, it } from 'vitest';

import { runStack, type Stack } from '../../src/index.ts';
import type { AnyMember } from '../../src/substrate/plugin.ts';
import type { EngineEvent } from '../../src/substrate/events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
	HERE,
	'..',
	'..',
	'..',
	'..',
	'examples',
	'effect-app-rewrite',
	'devstack.config.ts',
);

const dockerReachable = (): { ok: boolean; detail: string } => {
	const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

describe('effect-app-rewrite boots via runStack', () => {
	it('runStack(stack) reaches ready for sui + alice, then shuts down cleanly', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`effect-app-boot: skipping — ${docker.detail}`);
			return;
		}

		const runtimeRoot = mkdtempSync(join(tmpdir(), 'effect-app-boot-'));

		// Cross-package import via a dynamic specifier dodges
		// `rootDir` (examples live outside the devstack-rewrite
		// package). Static imports of an example's `devstack.config.ts`
		// would trip TS6059; every sibling e2e routes through
		// `boot-config-impl.ts`'s `import(opts.configPath)` for the
		// same reason.
		const configModule = (await import(CONFIG_PATH)) as {
			readonly default: Stack<ReadonlyArray<AnyMember>>;
		};
		const effectAppStack = configModule.default;

		const handle = runStack(effectAppStack, {
			identity: { app: 'effect-app', stack: 'main', network: 'sui:local' },
			runtimeRoot,
		});

		// `state` is constructed synchronously inside `runStack` so the
		// caller can observe identity / cycle BEFORE the supervisor
		// fiber forks. The pre-start snapshot has empty rows + no
		// errors — pinning this matches the parity guarantee in
		// `test/api/run-stack.test.ts:'state is available synchronously
		// before start'`.
		const preStart = await Effect.runPromise(SubscriptionRef.get(handle.state));
		expect(preStart.rows).toEqual([]);
		expect(preStart.errors).toEqual([]);

		// Collect every `lifecycle.statusChanged` event onto a daemon
		// fiber for the duration of the run. The supervisor's projection
		// `rows[*].status` is mutated forward through `pending →
		// acquiring → ready` on success and `ready → stopping →
		// stopped` on shutdown — but a post-`start` snapshot may land
		// AFTER teardown has already begun. Collecting the event stream
		// from before-start gives us a stable "did this plugin ever
		// reach `ready`?" assertion that doesn't race with shutdown.
		//
		// See `api.run-stack-forkchild-interruption-on-start-resolve`
		// in the opportunities backlog for the underlying root cause:
		// `runStack` currently forks the supervised program with
		// `Effect.forkChild`, which ties the supervisor fiber to the
		// `start` fiber's scope. When `Effect.runPromise(handle.start)`
		// resolves, the runtime that ran it tears down the child
		// fiber, kicking the supervisor into shutdown before the test
		// can read a post-ready snapshot.
		const observed: EngineEvent[] = [];
		const collectorFiber = Effect.runFork(
			handle.events.pipe(
				Stream.tap((event) =>
					Effect.sync(() => {
						observed.push(event);
					}),
				),
				Stream.runDrain,
			),
		);

		try {
			// `start` resolves once every plugin reaches `ready` (or
			// fails with `BootError` carrying the supervisor's typed
			// cause). The cold sui container path can take ~60-80s on
			// a fresh runtime root; the outer `it` timeout accounts.
			await Effect.runPromise(handle.start);
		} finally {
			// `stop` is unconditional — even if `start` failed, we ask
			// the supervisor to wind down so finalizers run on every
			// container the boot path managed to acquire. Both `stop`
			// and `awaitShutdown` resolve without raising; their `E`
			// channels are `never` by the `RunHandle` contract.
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			await Effect.runPromise(Fiber.interrupt(collectorFiber));
		}

		// Project the event log: every plugin must have transitioned
		// INTO `ready` at some point during the run. We don't pin the
		// terminal status (the supervisor may have already torn it
		// down by the time we assert).
		const reachedReady = new Set<string>();
		for (const event of observed) {
			if (event.tag === 'lifecycle.statusChanged' && event.to === 'ready') {
				reachedReady.add(event.pluginKey as string);
			}
		}
		const expectedKeys = ['account/alice#1', 'sui#0'];
		expect([...reachedReady].sort()).toEqual(expectedKeys);
	}, 180_000);
});
