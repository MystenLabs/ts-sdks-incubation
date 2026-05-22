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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Option, Stream, SubscriptionRef } from 'effect';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import type { CodegenableDecl } from '../../src/contracts/codegenable.ts';
import { CodegenRenderError } from '../../src/orchestrators/codegen/errors.ts';
import type { EngineEvent } from '../../src/substrate/events.ts';
import { SupervisorPostAcquireFailed } from '../../src/substrate/runtime/supervisor.ts';
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
	start: () => Effect.succeed({ ok: true } as const),
});

const runtimeCodegenPlugin = definePlugin({
	id: 'test/runtime-codegen',
	role: 'service',
	start: () => Effect.succeed({ message: 'from-acquire' } as const),
	capabilities: ({ value: resolved }) =>
		[
			{
				kind: 'codegenable',
				emitterName: 'runtime-proof',
				outputPath: 'runtime-proof.ts',
				sensitive: false,
				emit: (ctx) =>
					Effect.sync(() => {
						ctx.exportConst('runtimeProof', resolved);
						return ctx.done();
					}),
			} satisfies CodegenableDecl<'runtime-proof'>,
		] as const,
});

const failingRuntimeCodegenPlugin = definePlugin({
	id: 'test/failing-runtime-codegen',
	role: 'service',
	start: () => Effect.succeed({ message: 'from-acquire' } as const),
	capabilities: () =>
		[
			{
				kind: 'codegenable',
				emitterName: 'runtime-failure-proof',
				outputPath: 'runtime-failure-proof.ts',
				sensitive: false,
				emit: (ctx) =>
					Effect.sync(() => {
						ctx.exportConst('runtimeFailureProof', () => 'not serializable');
						return ctx.done();
					}),
			} satisfies CodegenableDecl<'runtime-failure-proof'>,
		] as const,
});

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'run-stack-test-'));

const expectSome = <A>(option: Option.Option<A>): A => {
	expect(Option.isSome(option)).toBe(true);
	if (Option.isSome(option)) return option.value;
	throw new Error('expected Some');
};

describe('api/run-stack', () => {
	it('start resolves once every plugin reaches ready, then stop tears down', async () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-test', stack: 'main', network: 'test:local' },
			runtimeRoot: makeRuntimeRoot(),
		});

		await Effect.runPromise(handle.start);

		const snapshot = await Effect.runPromise(SubscriptionRef.get(handle.state));
		expect(snapshot.identity).toEqual({
			app: 'run-stack-test',
			stack: 'main',
			network: 'test:local',
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
				identity: { network: 'test:local' },
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
			identity: { app: 'run-stack-noop', stack: 'main', network: 'test:local' },
			runtimeRoot: makeRuntimeRoot(),
		});
		await Effect.runPromise(handle.awaitShutdown);
	}, 10_000);

	it('awaitShutdown resolves after stop and is idempotent', async () => {
		const stack = defineDevstack({ members: [leaf], stackName: 'main' });
		const handle = runStack(stack, {
			identity: { app: 'run-stack-idempotent', stack: 'main', network: 'test:local' },
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
			identity: { app: 'run-stack-no-auto-interrupt', stack: 'main', network: 'test:local' },
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
			identity: { app: 'run-stack-sync', stack: 'main', network: 'test:local' },
			runtimeRoot: makeRuntimeRoot(),
		});

		// state is a SubscriptionRef created synchronously inside runStack
		// so consumers can subscribe to `state.changes` before start runs.
		const initial = Effect.runSync(SubscriptionRef.get(handle.state));
		expect(initial.rows).toEqual([]);
		expect(initial.errors).toEqual([]);
	});

	it('start runs codegen through the production post-acquire hook', async () => {
		const appRoot = mkdtempSync(join(tmpdir(), 'run-stack-codegen-app-'));
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'run-stack-codegen-state-'));
		const stack = defineDevstack({ members: [runtimeCodegenPlugin], stackName: 'main' });
		const handle = runStack(stack, {
			appRoot,
			identity: { app: 'run-stack-codegen', stack: 'main', network: 'test:local' },
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

			const generatedPath = join(appRoot, 'src', 'generated', 'runtime-proof.ts');
			expect(existsSync(generatedPath)).toBe(true);
			const mod = (await import(`${pathToFileURL(generatedPath).href}?t=${Date.now()}`)) as {
				readonly runtimeProof: { readonly message: string };
			};
			expect(mod.runtimeProof).toEqual({ message: 'from-acquire' });
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
			identity: { app: 'preview-install', stack: 'main', network: 'test:local' },
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
				chain: 'test:local',
			});
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(appRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it('start wraps production codegen hook failures and records error.reported', async () => {
		const appRoot = mkdtempSync(join(tmpdir(), 'run-stack-codegen-fail-app-'));
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'run-stack-codegen-fail-state-'));
		const stack = defineDevstack({ members: [failingRuntimeCodegenPlugin], stackName: 'main' });
		const handle = runStack(stack, {
			appRoot,
			identity: { app: 'run-stack-codegen-fail', stack: 'main', network: 'test:local' },
			runtimeRoot,
		});

		try {
			const exit = await Effect.runPromise(Effect.exit(handle.start));
			expect(Exit.isFailure(exit)).toBe(true);

			const bootError = expectSome(Exit.findErrorOption(exit));
			expect(bootError._tag).toBe('BootError');

			const supervisorFailure = expectSome(Cause.findErrorOption(bootError.cause));
			expect(supervisorFailure).toBeInstanceOf(SupervisorPostAcquireFailed);
			if (supervisorFailure instanceof SupervisorPostAcquireFailed) {
				const codegenFailure = expectSome(Cause.findErrorOption(supervisorFailure.cause));
				expect(codegenFailure).toBeInstanceOf(CodegenRenderError);
				if (codegenFailure instanceof CodegenRenderError) {
					expect(codegenFailure.emitterName).toBe('runtime-failure-proof');
					expect(codegenFailure.outputPath).toBe('runtime-failure-proof.ts');
				}
			}

			const snapshot = await Effect.runPromise(SubscriptionRef.get(handle.state));
			const reported = snapshot.errors.at(-1);
			expect(reported).toMatchObject({
				pluginKey: null,
				tag: 'CodegenRenderError',
				severity: 'error',
			});
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(appRoot, { recursive: true, force: true });
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
