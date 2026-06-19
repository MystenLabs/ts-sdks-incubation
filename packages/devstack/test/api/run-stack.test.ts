// `runStack` — programmatic handle invariants.
//
// Cutover blocker #3 (parity-matrix.md "Programmatic embedding"): pins
// the surface that library consumers depend on. Each test runs a small
// in-process stack (one leaf plugin) so the substrate Layer stack
// builds without Docker. The Docker `ContainerRuntimeService` layer
// itself is a `Layer.effect` that calls no daemon at build time; only
// plugins that yield it would.
//
// Pinned behaviors:
//
//   1. Happy-path boot: `start` resolves when every plugin reaches
//      ready; `state` reflects identity + cycle.
//   2. `stop` triggers graceful shutdown via the supervisor's
//      `shutdown.requested` command; `awaitShutdown` resolves after.
//   3. `awaitShutdown` is idempotent across multiple awaiters.
//   4. Subscribing to `state.changes` BEFORE `start` observes the
//      identity update emitted at boot.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Option, Stream, SubscriptionRef } from 'effect';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import type { EngineEvent } from '../../src/substrate/events.ts';
import { runStack } from '../../src/api/run-stack.ts';
import {
	discoverManifestPath,
	readStackContext,
} from '../../src/build-integrations/runtime/index.ts';

// A trivial leaf plugin: provides one resource, consumes nothing, returns a
// constant. Boot path: dep-graph -> topological order [self] ->
// start(self) -> ready. No docker, no network, no filesystem
// dependencies beyond what the substrate touches (stack paths +
// cache + manifest writer).
const leaf = definePlugin({
	id: 'test/leaf',
	role: 'service',
	section: 'service',
	start: () => Effect.succeed({ ok: true } as const),
});

class RunStackCustomService extends Context.Service<
	RunStackCustomService,
	{ readonly value: string }
>()('@devstack/test/RunStackCustomService') {}

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'run-stack-test-'));

describe('api/run-stack', () => {
	it('start resolves once every plugin reaches ready, then stop tears down', async () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-test', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});

		await Effect.runPromise(handle.start);

		const snapshot = await Effect.runPromise(SubscriptionRef.get(handle.state));
		expect(snapshot.identity).toEqual({
			app: 'run-stack-test',
			stack: 'main',
			network: 'localnet',
		});

		await Effect.runPromise(handle.stop);
		await Effect.runPromise(handle.awaitShutdown);
	}, 30_000);

	it('infers app and stack names from appRoot package metadata when not explicit', async () => {
		const appRoot = mkdtempSync(join(tmpdir(), 'run-stack-infer-app-'));
		writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: '@org/inferred-app' }));
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'run-stack-infer-state-'));
		const priorApp = process.env.DEVSTACK_APP;
		const priorStack = process.env.DEVSTACK_STACK;
		try {
			delete process.env.DEVSTACK_APP;
			delete process.env.DEVSTACK_STACK;
			const stack = defineDevstack({ members: [leaf] });
			const handle = runStack(stack, {
				appRoot,
				identity: { network: 'localnet' },
				runtimeRoot,
			});

			try {
				await Effect.runPromise(handle.start);

				const snapshot = await Effect.runPromise(SubscriptionRef.get(handle.state));
				expect(snapshot.identity.app).toBe('inferred-app');
				expect(snapshot.identity.stack).toBe('inferred-app');
			} finally {
				await Effect.runPromise(handle.stop);
				await Effect.runPromise(handle.awaitShutdown);
			}
		} finally {
			if (priorApp === undefined) delete process.env.DEVSTACK_APP;
			else process.env.DEVSTACK_APP = priorApp;
			if (priorStack === undefined) delete process.env.DEVSTACK_STACK;
			else process.env.DEVSTACK_STACK = priorStack;
			rmSync(appRoot, { recursive: true, force: true });
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it('awaitShutdown without start is a no-op', async () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-noop', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});
		await Effect.runPromise(handle.awaitShutdown);
	}, 10_000);

	it('awaitShutdown resolves after stop and is idempotent', async () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-idempotent', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});

		await Effect.runPromise(handle.start);
		await Effect.runPromise(handle.stop);
		// Awaiting twice — second await must complete immediately on the
		// already-finished fiber.
		await Effect.runPromise(handle.awaitShutdown);
		await Effect.runPromise(handle.awaitShutdown);
	}, 30_000);

	// Regression: pre-fix `runStack` used `Effect.forkChild`, which ties
	// the supervisor fiber to the `start` fiber's scope. Once
	// `Effect.runPromise(handle.start)` resolved (after `bootDeferred`
	// succeeded) the runtime interrupted the supervisor — transitioning
	// every plugin row through `ready → stopping → stopped` before the
	// caller could observe a post-ready snapshot. Post-fix (`forkDetach`),
	// the supervisor outlives `start` and the projection retains its
	// `ready` rows until `stop` is invoked. See
	// `api.run-stack-forkchild-interruption-on-start-resolve` in the
	// opportunities backlog.
	it('post-start snapshot retains ready rows (no auto-interrupt on start resolve)', async () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-no-auto-interrupt', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});

		try {
			await Effect.runPromise(handle.start);

			const snapshot = await Effect.runPromise(SubscriptionRef.get(handle.state));
			expect(snapshot.rows.length).toBeGreaterThan(0);
			const readyRows = snapshot.rows.filter((row) => row.status === 'ready');
			expect(readyRows.length).toBeGreaterThan(0);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
		}
	}, 30_000);

	it('state is available synchronously before start (caller can subscribe)', () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-sync', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});

		// state is a SubscriptionRef created synchronously inside runStack
		// so consumers can subscribe to `state.changes` before start runs.
		const initial = Effect.runSync(SubscriptionRef.get(handle.state));
		expect(initial.rows).toEqual([]);
		expect(initial.errors).toEqual([]);
	});

	it('extendContext adds services visible to plugin start effects', async () => {
		const observed: Array<string> = [];
		const customPlugin = definePlugin({
			id: 'test/custom-context',
			role: 'service',
			section: 'service',
			start: () =>
				Effect.gen(function* () {
					const service = yield* RunStackCustomService;
					yield* Effect.sync(() => {
						observed.push(service.value);
					});
					return { ok: true } as const;
				}),
		});
		const stack = defineDevstack({ members: [customPlugin], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-extend-context', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
			extendContext: (ctx) =>
				Effect.succeed(
					ctx.pipe(
						Context.add(RunStackCustomService, RunStackCustomService.of({ value: 'custom' })),
					),
				),
		});

		try {
			await Effect.runPromise(handle.start);
			expect(observed).toEqual(['custom']);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
		}
	}, 30_000);

	it('concurrent start calls share one supervisor fiber', async () => {
		let starts = 0;
		const counted = definePlugin({
			id: 'test/counted-start',
			role: 'service',
			section: 'service',
			start: () =>
				Effect.sync(() => {
					starts += 1;
					return { ok: true } as const;
				}),
		});
		const stack = defineDevstack({ members: [counted], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-concurrent-start', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});

		try {
			await Effect.runPromise(
				Effect.all([handle.start, handle.start], { concurrency: 'unbounded' }),
			);
			expect(starts).toBe(1);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
		}
	}, 30_000);

	it('interrupting one start waiter does not poison a later start call', async () => {
		const started = Effect.runSync(Deferred.make<void>());
		const release = Effect.runSync(Deferred.make<void>());
		const blocking = definePlugin({
			id: 'test/blocking-start',
			role: 'service',
			section: 'service',
			start: () =>
				Effect.gen(function* () {
					yield* Deferred.succeed(started, undefined);
					yield* Deferred.await(release);
					return { ok: true } as const;
				}),
		});
		const stack = defineDevstack({ members: [blocking], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-interrupted-start', stack: 'main', network: 'localnet' },
			runtimeRoot: makeRuntimeRoot(),
		});

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const startFiber = yield* Effect.forkScoped(handle.start);
						yield* Deferred.await(started);
						yield* Fiber.interrupt(startFiber);
						yield* Deferred.succeed(release, undefined);
						yield* handle.start;
					}),
				),
			);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
		}
	}, 30_000);

	it('events stream is available when boot fails before withinScope', async () => {
		const failingPlugin = definePlugin({
			id: 'test/failing-boot',
			role: 'service',
			section: 'service',
			start: () =>
				Effect.fail(new Error('intentional boot failure')).pipe(Effect.as({ ok: false } as const)),
		});
		const stack = defineDevstack({ members: [failingPlugin], stackName: 'main' });
		const runtimeRoot = makeRuntimeRoot();
		const handle = runStack(stack, {
			identity: { app: 'run-stack-boot-failure-events', stack: 'main', network: 'localnet' },
			runtimeRoot,
		});
		const firstEvent = Effect.runPromise(
			Stream.runHead(handle.events.pipe(Stream.take(1))).pipe(
				Effect.timeoutOption('5 seconds'),
				Effect.map((outer) => Option.getOrNull(Option.flatten(outer))),
			),
		);

		try {
			const exit = await Effect.runPromise(Effect.exit(handle.start));
			expect(Exit.isFailure(exit)).toBe(true);
			expect(await firstEvent).not.toBeNull();
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it('start writes the deployment through the production post-acquire hook', async () => {
		const appRoot = mkdtempSync(join(tmpdir(), 'run-stack-codegen-app-'));
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'run-stack-codegen-state-'));
		// Boot no longer emits a codegen tree; it assembles + writes the
		// deployment (the live on-chain ids the Vite plugin injects). The
		// committed `src/generated` tree is the stack-free `devstack codegen`
		// verb's job. Assert the boot wrote `deployment.json` and emitted
		// the `codegen.emitted` event pointing at it.
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			appRoot,
			identity: { app: 'run-stack-codegen', stack: 'main', network: 'localnet' },
			runtimeRoot,
		});

		try {
			await Effect.runPromise(handle.start);

			const emitted = await Effect.runPromise(
				Stream.runHead(
					handle.events.pipe(
						Stream.filter(
							(event): event is Extract<EngineEvent, { readonly tag: 'codegen.emitted' }> =>
								event.tag === 'codegen.emitted',
						),
						Stream.take(1),
					),
				),
			);
			expect(Option.isSome(emitted)).toBe(true);

			const deploymentPath = join(runtimeRoot, 'stacks', 'main', 'deployment.json');
			expect(existsSync(deploymentPath)).toBe(true);
			const envelope = JSON.parse(readFileSync(deploymentPath, 'utf8')) as {
				readonly defaultNetwork: string;
				readonly networks: Record<
					string,
					{
						readonly network: string;
						readonly packages: Record<string, unknown>;
						readonly mvrOverrides: Record<string, unknown>;
					}
				>;
			};
			expect(envelope.defaultNetwork).toBe('localnet');
			const unit = envelope.networks['localnet']!;
			expect(unit.network).toBe('localnet');
			// A leaf-only stack contributes no codegen — the deployment is valid
			// but empty.
			expect(unit.packages).toEqual({});
			expect(unit.mvrOverrides).toEqual({});
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(appRoot, { recursive: true, force: true });
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it('writes the manifest at the public runtime discovery path', async () => {
		const appRoot = mkdtempSync(join(tmpdir(), 'run-stack-preview-app-'));
		const runtimeRoot = join(appRoot, '.devstack');
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			appRoot,
			identity: { app: 'preview-install', stack: 'main', network: 'localnet' },
			runtimeRoot,
		});

		try {
			await Effect.runPromise(handle.start);

			const expectedManifestPath = join(runtimeRoot, 'stacks', 'main', 'manifest.json');
			expect(existsSync(expectedManifestPath)).toBe(true);
			expect(existsSync(join(runtimeRoot, 'preview-install', 'main', 'manifest.json'))).toBe(false);
			expect(discoverManifestPath({ cwd: appRoot, env: {}, stack: 'main' })).toBe(
				expectedManifestPath,
			);

			const ctx = readStackContext({ cwd: appRoot, env: {}, stack: 'main' });
			expect(ctx.manifestPath).toBe(expectedManifestPath);
			expect(ctx.identity).toEqual({
				app: 'preview-install',
				stack: 'main',
				network: 'localnet',
			});
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(appRoot, { recursive: true, force: true });
		}
	}, 30_000);

	// Regression: pre-Phase-B `runStack` accepted any string for
	// `identity.network` and only validated downstream when a plugin
	// probed the chain id. Phase B4 routed both runStack and cli/main
	// through `parseDevstackNetwork` (via `resolveNetworkSync`) so a
	// bogus value fails fast at the boundary with the typed
	// `DevstackNetworkParseError`.
	it('rejects a bogus identity.network value via parseDevstackNetwork', () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		expect(() =>
			runStack(stack, {
				identity: { app: 'rs-bad-net', stack: 'main', network: 'not-a-network' },
				runtimeRoot: makeRuntimeRoot(),
			}),
		).toThrowError(/DEVSTACK_NETWORK|network|not-a-network/);
	});
});
