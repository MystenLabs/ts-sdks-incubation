import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { Deferred, Effect, Fiber, Ref, Stream } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import type {
	ContainerHandle,
	ContainerRuntime,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	acquireChainBuildContainer,
	moveBuildLockPathFor,
} from '../../../src/plugins/sui/chain-build-container.ts';

const unusedRuntimeMethod = () => Effect.die('not used');

const handleFor = (spec: EnsureContainerSpec): ContainerHandle => ({
	id: 'build-container-id',
	name: spec.name,
	labels: spec.labels,
	imageName: spec.image.tag ?? spec.image.digest,
	status: 'running',
	ips: [],
});

const runtimeFromExec = (exec: ContainerRuntime['exec']): ContainerRuntime => ({
	ensureImage: unusedRuntimeMethod,
	ensureNetwork: unusedRuntimeMethod,
	ensureContainer: (spec) => Effect.succeed(handleFor(spec)),
	exec,
	runOneShot: unusedRuntimeMethod,
	inspectByLabels: unusedRuntimeMethod,
	followLogs: () => Stream.empty,
	pause: unusedRuntimeMethod,
	pauseAndCommit: unusedRuntimeMethod,
	saveImage: () => Stream.empty,
	saveImages: () => Stream.empty,
	loadImage: unusedRuntimeMethod,
	tagImage: unusedRuntimeMethod,
	removeImage: unusedRuntimeMethod,
	unpause: unusedRuntimeMethod,
	stop: unusedRuntimeMethod,
	sweepOrphans: unusedRuntimeMethod,
	removeManagedContainers: unusedRuntimeMethod,
	removeManagedImages: unusedRuntimeMethod,
	removeManagedNetworks: unusedRuntimeMethod,
	removeManagedVolumes: unusedRuntimeMethod,
});

const makeFixture = () => {
	const root = mkdtempSync(join(tmpdir(), 'chain-build-container-test-'));
	const appDir = join(root, 'app');
	const packagePath = join(appDir, 'packages', 'demo');
	const moveHome = join(root, 'home', '.move');
	mkdirSync(packagePath, { recursive: true });
	mkdirSync(moveHome, { recursive: true });
	return {
		root,
		packagePath,
		spec: {
			app: 'demo',
			stack: 'test',
			appDir,
			moveHome,
			image: { digest: 'sha256:sui' },
		},
	};
};

const okExecResult = { exitCode: 0, stdout: '{}', stderr: '' };

describe('chain build container move-build lock', () => {
	it.effect('runBuild holds the host-wide move-build lock around docker exec', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				const lockPath = moveBuildLockPathFor(fixture.spec.appDir, fixture.spec.moveHome);
				let sawLock = false;
				const runtime = runtimeFromExec(() =>
					Effect.sync(() => {
						sawLock = existsSync(lockPath);
						const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { readonly pid: number };
						expect(holder.pid).toBe(process.pid);
						return okExecResult;
					}),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const buildContainer = yield* acquireChainBuildContainer(runtime, fixture.spec);
						const result = yield* buildContainer.runBuild(fixture.packagePath);
						expect(result).toEqual(okExecResult);
					}),
				);

				expect(sawLock).toBe(true);
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('runBuild reclaims stale move-build lock files before docker exec', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				const lockPath = moveBuildLockPathFor(fixture.spec.appDir, fixture.spec.moveHome);
				mkdirSync(dirname(lockPath), { recursive: true });
				writeFileSync(
					lockPath,
					JSON.stringify({
						pid: -1,
						startTime: 0,
						hostname: hostname(),
						claimedAt: Date.now() - 60_000,
						heartbeatAt: Date.now() - 60_000,
						intent: 'normal',
					}),
				);

				let execCount = 0;
				const runtime = runtimeFromExec(() =>
					Effect.sync(() => {
						execCount += 1;
						const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { readonly pid: number };
						expect(holder.pid).toBe(process.pid);
						return okExecResult;
					}),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const buildContainer = yield* acquireChainBuildContainer(runtime, fixture.spec);
						const result = yield* buildContainer.runBuild(fixture.packagePath);
						expect(result).toEqual(okExecResult);
					}),
				);

				expect(execCount).toBe(1);
				expect(existsSync(lockPath)).toBe(false);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);

	it.live('runBuild serializes concurrent docker execs through the move-build lock', () =>
		Effect.gen(function* () {
			const fixture = makeFixture();
			try {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const firstEntered = yield* Deferred.make<void>();
						const releaseFirst = yield* Deferred.make<void>();
						const callCount = yield* Ref.make(0);
						const events = yield* Ref.make<ReadonlyArray<string>>([]);
						const append = (event: string) => Ref.update(events, (current) => [...current, event]);
						const runtime = runtimeFromExec(() =>
							Effect.gen(function* () {
								const call = yield* Ref.updateAndGet(callCount, (n) => n + 1);
								if (call === 1) {
									yield* append('first-in');
									yield* Deferred.succeed(firstEntered, undefined);
									yield* Deferred.await(releaseFirst);
									yield* append('first-out');
								} else {
									yield* append('second-in');
									yield* append('second-out');
								}
								return okExecResult;
							}),
						);
						const buildContainer = yield* acquireChainBuildContainer(runtime, fixture.spec);

						const first = yield* Effect.forkScoped(buildContainer.runBuild(fixture.packagePath));
						yield* Deferred.await(firstEntered);
						const second = yield* Effect.forkScoped(buildContainer.runBuild(fixture.packagePath));

						yield* Effect.sleep('75 millis');
						expect(yield* Ref.get(events)).toEqual(['first-in']);

						yield* Deferred.succeed(releaseFirst, undefined);
						yield* Fiber.join(first);
						yield* Fiber.join(second);

						expect(yield* Ref.get(events)).toEqual([
							'first-in',
							'first-out',
							'second-in',
							'second-out',
						]);
					}),
				);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}),
	);
});
