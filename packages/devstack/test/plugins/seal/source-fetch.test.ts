import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import type {
	ContainerRuntime,
	ContainerRuntimeError,
	ExecResult,
	OneShotSpec,
} from '../../../src/contracts/container-runtime.ts';
import {
	DEFAULT_SEAL_MOVE_SUBDIR,
	DEFAULT_SEAL_REPO,
	DEFAULT_SEAL_VERSION,
	resolveDefaultSealSource,
	sealSourceCacheDir,
	sealSourcePublishLockPath,
	SEAL_SOURCE_FETCH_IMAGE,
} from '../../../src/plugins/seal/bootstrap-assets/source-fetch.ts';

const nodePlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const resolveWithNodePlatform = (runtime: ContainerRuntime) =>
	Effect.scoped(resolveDefaultSealSource(runtime)).pipe(Effect.provide(nodePlatformLayer));

const expectedHostUser = (): string | undefined =>
	typeof process.getuid === 'function' && typeof process.getgid === 'function'
		? `${process.getuid()}:${process.getgid()}`
		: undefined;

const makeRuntimeStub = (
	runOneShot: (spec: OneShotSpec) => Effect.Effect<ExecResult, ContainerRuntimeError>,
): ContainerRuntime =>
	({
		ensureImage: () => Effect.die('ensureImage not used'),
		ensureNetwork: () => Effect.die('ensureNetwork not used'),
		ensureContainer: () => Effect.die('ensureContainer not used'),
		exec: () => Effect.die('exec not used'),
		runOneShot,
		inspectByLabels: () => Effect.die('inspectByLabels not used'),
		followLogs: () => Effect.die('followLogs not used'),
		pauseAndCommit: () => Effect.die('pauseAndCommit not used'),
		saveImage: () => Effect.die('saveImage not used'),
		loadImage: () => Effect.die('loadImage not used'),
		tagImage: () => Effect.die('tagImage not used'),
		removeImage: () => Effect.die('removeImage not used'),
		unpause: () => Effect.die('unpause not used'),
		stop: () => Effect.die('stop not used'),
		sweepOrphans: () => Effect.die('sweepOrphans not used'),
		removeManagedContainers: () => Effect.die('removeManagedContainers not used'),
		removeManagedImages: () => Effect.die('removeManagedImages not used'),
		removeManagedNetworks: () => Effect.die('removeManagedNetworks not used'),
		removeManagedVolumes: () => Effect.die('removeManagedVolumes not used'),
	}) as unknown as ContainerRuntime;

const withTempHome = <A, E>(body: (home: string) => Effect.Effect<A, E>) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const home = mkdtempSync(join(tmpdir(), 'seal-source-fetch-'));
			const previousHome = process.env.HOME;
			const previousOverride = process.env.SEAL_MOVE_SOURCE_OVERRIDE;
			process.env.HOME = home;
			delete process.env.SEAL_MOVE_SOURCE_OVERRIDE;
			return { home, previousHome, previousOverride };
		}),
		({ home }) => body(home),
		({ home, previousHome, previousOverride }) =>
			Effect.sync(() => {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousOverride === undefined) delete process.env.SEAL_MOVE_SOURCE_OVERRIDE;
				else process.env.SEAL_MOVE_SOURCE_OVERRIDE = previousOverride;
				rmSync(home, { recursive: true, force: true });
			}),
	);

describe('resolveDefaultSealSource', () => {
	it.effect('returns SEAL_MOVE_SOURCE_OVERRIDE without touching the runtime', () =>
		withTempHome(() => {
			process.env.SEAL_MOVE_SOURCE_OVERRIDE = '/tmp/prefetched/seal/move/seal';
			let calls = 0;
			const runtime = makeRuntimeStub(() => {
				calls += 1;
				return Effect.die('runOneShot should not be called for an override');
			});
			return Effect.gen(function* () {
				const result = yield* resolveWithNodePlatform(runtime);
				expect(result.path).toBe('/tmp/prefetched/seal/move/seal');
				expect(calls).toBe(0);
			});
		}),
	);

	it.effect('returns the cached move package path without cloning', () =>
		withTempHome(() => {
			const cacheDir = sealSourceCacheDir(DEFAULT_SEAL_VERSION);
			const sourceDir = join(cacheDir, DEFAULT_SEAL_MOVE_SUBDIR);
			mkdirSync(sourceDir, { recursive: true });
			writeFileSync(join(sourceDir, 'Move.toml'), '[package]\n');
			const runtime = makeRuntimeStub(() => Effect.die('runOneShot should not be called'));
			return Effect.gen(function* () {
				const result = yield* resolveWithNodePlatform(runtime);
				expect(result).toEqual({
					repo: DEFAULT_SEAL_REPO,
					ref: DEFAULT_SEAL_VERSION,
					subdir: DEFAULT_SEAL_MOVE_SUBDIR,
					path: sourceDir,
				});
			});
		}),
	);

	it.effect('fills the cache with an alpine/git one-shot and returns move/seal', () =>
		withTempHome(() => {
			const calls: OneShotSpec[] = [];
			const runtime = makeRuntimeStub((spec) => {
				calls.push(spec);
				const out = spec.mounts?.find((mount) => mount.target === '/out')?.source;
				if (out === undefined) return Effect.die('missing /out mount');
				mkdirSync(join(out, DEFAULT_SEAL_MOVE_SUBDIR), { recursive: true });
				writeFileSync(join(out, DEFAULT_SEAL_MOVE_SUBDIR, 'Move.toml'), '[package]\n');
				return Effect.succeed({ exitCode: 0, stdout: 'cloned', stderr: '' });
			});
			return Effect.gen(function* () {
				const result = yield* resolveWithNodePlatform(runtime);
				const cacheDir = sealSourceCacheDir(DEFAULT_SEAL_VERSION);
				const sourceDir = join(cacheDir, DEFAULT_SEAL_MOVE_SUBDIR);
				expect(result.path).toBe(sourceDir);
				expect(existsSync(sourceDir)).toBe(true);
				expect(calls).toHaveLength(1);
				expect(calls[0]).toMatchObject({
					image: { digest: SEAL_SOURCE_FETCH_IMAGE, tag: SEAL_SOURCE_FETCH_IMAGE },
					entrypoint: 'git',
					user: expectedHostUser(),
					argv: [
						'clone',
						'--depth',
						'1',
						'--branch',
						DEFAULT_SEAL_VERSION,
						DEFAULT_SEAL_REPO,
						'/out',
					],
					timeoutMillis: 300_000,
				});
				const mount = calls[0]!.mounts?.[0];
				expect(mount?.target).toBe('/out');
				expect(mount?.source.startsWith(`${cacheDir}.staging.`)).toBe(true);
				expect(existsSync(mount!.source)).toBe(false);
				expect(sealSourcePublishLockPath(DEFAULT_SEAL_VERSION)).toBe(`${cacheDir}.publish.lock`);
				expect(existsSync(sealSourcePublishLockPath(DEFAULT_SEAL_VERSION))).toBe(false);
			});
		}),
	);

	it.effect('promotes non-zero git clone exits to SealError', () =>
		withTempHome(() => {
			const runtime = makeRuntimeStub(() =>
				Effect.succeed({
					exitCode: 42,
					stdout: 'stdout before failure',
					stderr: 'fatal: failed to clone',
				}),
			);
			return Effect.gen(function* () {
				const error = yield* resolveWithNodePlatform(runtime).pipe(Effect.flip);
				expect(error._tag).toBe('SealError');
				expect(error.phase).toBe('image');
				expect(error.exitCode).toBe(42);
				expect(error.message).toContain('git clone exited 42');
				expect(error.stderr).toBe('fatal: failed to clone');
				expect(existsSync(sealSourceCacheDir(DEFAULT_SEAL_VERSION))).toBe(false);
			});
		}),
	);
});
