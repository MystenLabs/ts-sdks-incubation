// CLI-boot smoke — the Docker-free gate on the `up` cutover (S3).
//
// `cli/wirings/up.ts` no longer forks its own parallel supervised boot; it
// builds its CLI concerns (the snapshot/wipe/prune `commandHandler` + the
// recover→warm→IPC→roster→TUI `beforeInitialAcquire` hook + the warm-capture
// `withinScope` hook) as a VALUE bundle via `buildUpBootBundle` and feeds them
// to the ONE boot seam, `runStackWithBoot`. `test/cli/main.test.ts` only runs
// `up --help` — it never boots a supervisor — so this is the actual regression
// gate that the cutover preserves the load-bearing CLI boot behavior.
//
// Drives the REAL bundle (`buildUpBootBundle`) through `runStackWithBoot`
// against a minimal leaf stack (NO Docker plugins) and asserts:
//
//   (a) RECOVER-BEFORE-ACQUIRE. The interrupted-restore recovery runs inside
//       `beforeInitialAcquire`, ahead of the first plugin acquire (the PR#21
//       ordering). Proven Docker-free: an interrupted-restore sentinel carrying
//       an UNSAFE snapshot id is dropped into the stack root; the bundle's
//       recover clears it (the unsafe-id branch — no `restore`, no Docker), and
//       the leaf plugin records — at acquire time — that the sentinel is
//       already gone. Sentinel-cleared-before-acquire ⇒ recover ran first.
//
//   (b) ROSTER → EXIT 40. A pre-claimed roster lock (a sibling supervisor) makes
//       the bundle's `installLiveSupervisorRoster` lose sole-holdership →
//       `handle.start` fails with `BootError`, and `findCliSupervisorLiveError`
//       extracts the `CliSupervisorLiveError` the CLI projects to exit 40.
//
//   (c) BOOT IDENTITY PROJECTION. After a clean `handle.start`, the renderer's
//       data source — `handle.state` — carries the boot identity (the supervisor
//       seeds `setIdentity` at boot), so the TUI (a pure `handle.state` consumer
//       post-cutover) renders the right app/stack/network.
//
// All Docker-free: the leaf plugin touches no daemon; the substrate Layer stack
// builds without a container-runtime call (same idiom as test/api/run-stack*).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, FileSystem, SubscriptionRef } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';

import { defineDevstack } from '../../src/api/define-devstack.ts';
import { definePlugin } from '../../src/api/define-plugin.ts';
import type { BootError } from '../../src/api/run-stack.ts';
import { runStackWithBoot } from '../../src/api/run-stack-internal.ts';
import { buildUpBootBundle } from '../../src/cli/wirings/up.ts';
import { findCliSupervisorLiveError, identityValueFor } from '../../src/cli/wirings/identity.ts';
import { StackPathsService } from '../../src/substrate/runtime/paths.ts';
import { claim, release, type SupervisedStack } from '../../src/substrate/runtime/index.ts';
import {
	RESTORE_SENTINEL_FILE_NAME,
	SNAPSHOT_RESTORE_SENTINEL_VERSION,
} from '../../src/orchestrators/snapshot/index.ts';

const makeRuntimeRoot = () => mkdtempSync(join(tmpdir(), 'up-boot-smoke-'));

const STACK = 'main';
const APP = 'up-boot-smoke';
const NETWORK = 'localnet';

const stackRootFor = (runtimeRoot: string) => join(runtimeRoot, 'stacks', STACK);
const sentinelPathFor = (runtimeRoot: string) =>
	join(stackRootFor(runtimeRoot), RESTORE_SENTINEL_FILE_NAME);

/** Run a small filesystem setup/teardown effect against the real node fs +
 *  a scope (so `claim`/`release` finalizers + heartbeat forks resolve). */
const runFs = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
	Effect.runPromise(
		effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)) as Effect.Effect<A>,
	);

/** The `ResolvedIdentity`-derived `Identity` the bundle threads into the
 *  roster/channel/warm paths — built the same way the CLI does. */
const identityValue = identityValueFor({
	app: APP,
	stack: STACK,
	network: NETWORK,
	runtimeRoot: '',
	stacksRoot: '',
	stackRoot: '',
	rosterFile: '',
});

/** A minimal `SupervisedStack` shape the bundle only reads under `--warm`
 *  (gated off here), so its members/options are inert for this gate. */
const inertStack: SupervisedStack = {
	_tag: 'Stack',
	members: [],
	options: {},
} as unknown as SupervisedStack;

const makeBundle = (runtimeRoot: string) =>
	buildUpBootBundle({
		stack: inertStack,
		identityValue,
		runtimeRoot,
		appRoot: runtimeRoot,
		resolvedConfigPath: join(runtimeRoot, 'devstack.config.ts'),
		devstackVersion: '0.0.0-smoke',
		// `plain` so `makeTuiSurface` never reaches for a TTY in CI.
		rendererMode: 'plain',
		// Warm OFF: the warm hooks are out of scope for this smoke gate (they
		// have e2e coverage); keep the boot path cold + Docker-free.
		warmEnabled: false,
	});

describe('cli/up boot smoke (Docker-free)', () => {
	// ── (a) RECOVER BEFORE ACQUIRE ──────────────────────────────────────
	it('runs interrupted-restore recovery before the first plugin acquire', async () => {
		const runtimeRoot = makeRuntimeRoot();
		const order: string[] = [];
		let sentinelClearedAtAcquire = false;

		// The leaf plugin's `start` IS the first acquire side effect. It reads
		// the sentinel state at that moment: if recover already cleared it, the
		// recovery ran FIRST (inside `beforeInitialAcquire`, before acquire).
		const leaf = definePlugin({
			id: 'test/up-smoke-recover-leaf',
			role: 'service' as const,
			section: 'service',
			start: () =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const stackPaths = yield* StackPathsService;
					const sentinel = join(stackPaths.stackRoot, RESTORE_SENTINEL_FILE_NAME);
					const stillThere = yield* fs
						.exists(sentinel)
						.pipe(Effect.catch(() => Effect.succeed(true)));
					sentinelClearedAtAcquire = !stillThere;
					order.push('plugin-acquire');
					return { ok: true } as const;
				}),
		});
		const stack = defineDevstack({ members: [leaf], stackName: STACK });

		// Drop an interrupted-restore sentinel with an UNSAFE snapshot id into
		// the live stack root. `recoverInterruptedRestore` reads it, takes the
		// unsafe-id branch (logs + CLEARS the sentinel — no `restore`, no Docker)
		// before the first acquire observes the runtime root.
		await runFs(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(stackRootFor(runtimeRoot), { recursive: true });
				yield* fs.writeFileString(
					sentinelPathFor(runtimeRoot),
					JSON.stringify({
						version: SNAPSHOT_RESTORE_SENTINEL_VERSION,
						// Slashes/spaces make this id fail `parseSnapshotId` → the
						// unsafe-id branch fires (clear + log; no restore attempted).
						snapshotId: 'not a/safe id',
						artifactDir: join(stackRootFor(runtimeRoot), 'snapshots', 'x'),
					}),
				);
			}),
		);

		const { commandHandler, boot } = makeBundle(runtimeRoot);
		const handle = runStackWithBoot(stack, {
			identity: { app: APP, stack: STACK, network: NETWORK },
			runtimeRoot,
			appRoot: runtimeRoot,
			commandHandler,
			boot,
		});

		try {
			const exit = await Effect.runPromise(
				Effect.exit(handle.start.pipe(Effect.timeout('10 seconds'))),
			);
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(order).toContain('plugin-acquire');
			// The sentinel was cleared by recover BEFORE the plugin acquired.
			expect(sentinelClearedAtAcquire).toBe(true);
			// And it stays cleared after boot.
			expect(existsSync(sentinelPathFor(runtimeRoot))).toBe(false);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	// ── (b) ROSTER → EXIT 40 ────────────────────────────────────────────
	it('a pre-claimed roster lock fails handle.start with a CliSupervisorLiveError (exit 40)', async () => {
		const runtimeRoot = makeRuntimeRoot();
		const leaf = definePlugin({
			id: 'test/up-smoke-roster-leaf',
			role: 'service' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const stack = defineDevstack({ members: [leaf], stackName: STACK });

		const stackRoot = stackRootFor(runtimeRoot);
		const rosterPaths = {
			stackLockFile: join(stackRoot, 'stack.lock'),
			rosterFile: join(stackRoot, 'roster.json'),
		};

		// Pre-claim the roster as a sibling supervisor so the bundle's
		// `installLiveSupervisorRoster` loses sole-holdership. `claim` returns
		// inside the scope; we keep the claim live across `handle.start` by
		// writing the roster + lock and not releasing until teardown.
		await runFs(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(stackRoot, { recursive: true });
			}),
		);
		await Effect.runPromise(
			claim(rosterPaths).pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<unknown>,
		);

		const { commandHandler, boot } = makeBundle(runtimeRoot);
		const handle = runStackWithBoot(stack, {
			identity: { app: APP, stack: STACK, network: NETWORK },
			runtimeRoot,
			appRoot: runtimeRoot,
			commandHandler,
			boot,
		});

		try {
			const exit = await Effect.runPromise(
				Effect.exit(handle.start.pipe(Effect.timeout('10 seconds'))),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
			expect(error?._tag === 'Some' && (error.value as BootError)._tag).toBe('BootError');

			// The CLI's exit-40 extractor pulls the live error out of the cause.
			const bootError = error?._tag === 'Some' ? (error.value as BootError) : undefined;
			const live = bootError !== undefined ? findCliSupervisorLiveError(bootError.cause) : null;
			expect(live).not.toBeNull();
			expect(live?._tag).toBe('CliSupervisorLiveError');
			expect(live?.app).toBe(APP);
			expect(live?.stack).toBe(STACK);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			await Effect.runPromise(
				release(rosterPaths).pipe(
					Effect.provide(NodeFileSystem.layer),
					Effect.catch(() => Effect.void),
				) as Effect.Effect<void>,
			);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);

	// ── (c) BOOT IDENTITY PROJECTION ────────────────────────────────────
	it('handle.state carries the boot identity projection after start', async () => {
		const runtimeRoot = makeRuntimeRoot();
		const leaf = definePlugin({
			id: 'test/up-smoke-identity-leaf',
			role: 'service' as const,
			section: 'service',
			start: () => Effect.succeed({ ok: true } as const),
		});
		const stack = defineDevstack({ members: [leaf], stackName: STACK });

		const { commandHandler, boot } = makeBundle(runtimeRoot);
		const handle = runStackWithBoot(stack, {
			identity: { app: APP, stack: STACK, network: NETWORK },
			runtimeRoot,
			appRoot: runtimeRoot,
			commandHandler,
			boot,
		});

		try {
			const exit = await Effect.runPromise(
				Effect.exit(handle.start.pipe(Effect.timeout('10 seconds'))),
			);
			expect(Exit.isSuccess(exit)).toBe(true);

			// The renderer's data source — `handle.state` — carries the boot
			// identity the supervisor seeded via `setIdentity` at boot.
			const projection = await Effect.runPromise(SubscriptionRef.get(handle.state));
			expect(projection.identity.app).toBe(APP);
			expect(projection.identity.stack).toBe(STACK);
			expect(projection.identity.network).toBe(NETWORK);
		} finally {
			await Effect.runPromise(handle.stop);
			await Effect.runPromise(handle.awaitShutdown);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
