import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from 'vitest';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { Effect, Layer, Ref } from 'effect';

import type { EnsureContainerSpec } from '../../../src/contracts/container-runtime.ts';
import {
	DockerSpawner,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/client.ts';
import { ensureContainer, type PerNameLockState } from '../../../src/runtime/docker/container.ts';
import {
	ContainerRuntimeService,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
} from '../../../src/runtime/docker/service.ts';
import { CacheService } from '../../../src/substrate/runtime/cache/index.ts';
import { StackPathsService, type StackPaths } from '../../../src/substrate/runtime/paths.ts';

const layerDockerSpawnerFromNode: Layer.Layer<DockerSpawner, never, ChildProcessSpawner> =
	Layer.effect(
		DockerSpawner,
		Effect.gen(function* () {
			return yield* ChildProcessSpawner;
		}),
	);

const fakeDockerLayer = (bin: string): Layer.Layer<DockerHost | DockerSpawner> =>
	Layer.merge(
		layerDockerHost({ bin }),
		layerDockerSpawnerFromNode.pipe(
			Layer.provideMerge(
				NodeChildProcessSpawner.layer.pipe(
					Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
				),
			),
		),
	);

const stackPathsFor = (stackRoot: string): StackPaths => {
	const cacheDir = join(stackRoot, 'cache');
	const cacheNamespaceDir = (namespace: string): string => join(cacheDir, namespace);
	const cacheChainDir = (namespace: string, chain: string): string =>
		join(cacheNamespaceDir(namespace), chain);
	const cacheEntry = (
		namespace: string,
		chain: string,
		contentHash: string,
	): { readonly dir: string; readonly file: string } => {
		const dir = cacheChainDir(namespace, chain);
		return { dir, file: join(dir, `${contentHash}.json`) };
	};
	return {
		stackRoot,
		stateFile: join(stackRoot, 'state.json'),
		stateLockHint: join(stackRoot, 'state.json.lock'),
		cacheDir,
		snapshotDir: join(stackRoot, 'snapshots'),
		stackLockFile: join(stackRoot, 'stack.lock'),
		rosterFile: join(stackRoot, 'roster.json'),
		snapshotReservationFile: join(stackRoot, 'snapshot.reservation'),
		cacheEntry,
		cacheChainDir,
		cacheNamespaceDir,
	};
};

const stackPathsLayer = (stackRoot: string): Layer.Layer<StackPathsService> =>
	Layer.succeed(StackPathsService)(stackPathsFor(stackRoot));

const cacheLayer = Layer.succeed(CacheService)({
	lookup: () => Effect.succeed(null),
	write: () => Effect.void,
	delete: () => Effect.void,
});

const dockerRuntimeLayer = (bin: string, stackRoot: string): Layer.Layer<ContainerRuntimeService> =>
	layerContainerRuntimeDocker.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				fakeDockerLayer(bin),
				stackPathsLayer(stackRoot),
				layerDockerCycleInitial,
				cacheLayer,
			),
		),
	);

describe('ensureContainer paused adoption', () => {
	it('unpauses a matching paused container before adopting it as running', async () => {
		const root = mkdtempSync(join(tmpdir(), 'docker-ensure-paused-test-'));
		try {
			const bin = join(root, 'docker');
			const log = join(root, 'docker.log');
			const stackRoot = join(root, 'stack');
			mkdirSync(stackRoot, { recursive: true });
			const inspectJson = JSON.stringify([
				{
					Id: 'paused-id',
					Image: 'sha256:desired',
					HostConfig: { PortBindings: {} },
					State: { Running: true, Paused: true, ExitCode: 0 },
					Config: {
						Image: 'img:desired',
						Labels: {
							'devstack.managed': 'true',
							'devstack.app': 'app',
							'devstack.stack': 'main',
							'devstack.plugin': 'postgres',
							'devstack.role': 'db',
						},
					},
					NetworkSettings: { Networks: {} },
				},
			]);
			writeFileSync(
				bin,
				[
					'#!/bin/sh',
					`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(inspectJson)}`,
					'  exit 0',
					'fi',
					'exit 0',
					'',
				].join('\n'),
			);
			chmodSync(bin, 0o755);

			const spec: EnsureContainerSpec = {
				name: 'devstack-paused',
				image: { digest: 'sha256:desired', tag: 'img:desired' },
				labels: {
					app: 'app',
					stack: 'main',
					plugin: 'postgres',
					role: 'db',
				},
				recreate: 'on-failure',
			};
			const handle = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(spec, { cycle: 1, perNameLock });
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot)))),
			);

			const lines = readFileSync(log, 'utf8').trim().split('\n');
			expect(handle.status).toBe('running');
			expect(lines).toContain('unpause devstack-paused');
			expect(lines.some((line) => line.startsWith('start '))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('snapshot pauseAndCommit', () => {
	it('commits exited and created containers without pausing them', async () => {
		const root = mkdtempSync(join(tmpdir(), 'docker-commit-stopped-test-'));
		try {
			const bin = join(root, 'docker');
			const log = join(root, 'docker.log');
			const stackRoot = join(root, 'stack');
			mkdirSync(stackRoot, { recursive: true });
			writeFileSync(
				bin,
				[
					'#!/bin/sh',
					`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
					'if [ "$1" = "inspect" ]; then',
					'  if [ "$2" = "exited-container" ]; then',
					'    printf "%s\\n" \'[{"Id":"exited-id","Image":"image:before","HostConfig":{"PortBindings":{}},"State":{"Running":false,"Paused":false,"ExitCode":0},"Config":{"Image":"image:before","Labels":{"devstack.managed":"true","devstack.app":"app","devstack.stack":"main","devstack.plugin":"postgres","devstack.role":"db"}},"NetworkSettings":{"Networks":{}}}]\'',
					'    exit 0',
					'  fi',
					'  if [ "$2" = "created-container" ]; then',
					'    printf "%s\\n" \'[{"Id":"created-id","Image":"image:before","HostConfig":{"PortBindings":{}},"State":{"Running":false,"Paused":false,"ExitCode":0},"Config":{"Image":"image:before","Labels":{"devstack.managed":"true","devstack.app":"app","devstack.stack":"main","devstack.plugin":"postgres","devstack.role":"db"}},"NetworkSettings":{"Networks":{}}}]\'',
					'    exit 0',
					'  fi',
					'fi',
					'if [ "$1" = "commit" ]; then',
					'  printf "sha256:committed\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "pause" ]; then',
					'  echo "unexpected pause" >&2',
					'  exit 1',
					'fi',
					'exit 0',
					'',
				].join('\n'),
			);
			chmodSync(bin, 0o755);

			const refs = await Effect.runPromise(
				Effect.gen(function* () {
					const runtime = yield* ContainerRuntimeService;
					const exited = yield* runtime.pauseAndCommit({
						id: 'exited-id',
						name: 'exited-container',
						labels: {
							app: 'app',
							stack: 'main',
							plugin: 'postgres',
							role: 'db',
						},
						imageName: 'image:before',
						status: 'exited',
						ips: [],
					});
					const created = yield* runtime.pauseAndCommit({
						id: 'created-id',
						name: 'created-container',
						labels: {
							app: 'app',
							stack: 'main',
							plugin: 'postgres',
							role: 'db',
						},
						imageName: 'image:before',
						status: 'created',
						ips: [],
					});
					return [exited, created] as const;
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, stackRoot))),
			);

			expect(refs.map((ref) => ref.digest)).toEqual(['sha256:committed', 'sha256:committed']);
			const lines = readFileSync(log, 'utf8').trim().split('\n');
			expect(lines).toHaveLength(4);
			expect(lines[1]).toMatch(
				/^commit exited-container devstack-snapshot:exited-container-[a-f0-9]{12}$/,
			);
			expect(lines[3]).toMatch(
				/^commit created-container devstack-snapshot:created-container-[a-f0-9]{12}$/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
