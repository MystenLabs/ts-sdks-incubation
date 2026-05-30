// Regression cover for `EnsureContainerSpec.networkAttach` per-network
// aliases (backlog 37a). Pinned to the Docker reference impl: a spec
// carrying `{ name, aliases }` for the primary attach must emit
// `--network-alias` flags into the `docker run` argv; a secondary
// attach with aliases must pass `--alias` flags into `docker network
// connect`.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Ref } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { EnsureContainerSpec } from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import {
	DockerSpawner,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/client.ts';
import { ensureContainer, type PerNameLockState } from '../../../src/runtime/docker/container.ts';
import { StackPathsService, type StackPaths } from '../../../src/substrate/runtime/paths.ts';

const labels: ContainerLabelTuple = {
	app: 'app',
	stack: 'main',
	plugin: 'postgres',
	role: 'db',
};

const baseSpec = (overrides: Partial<EnsureContainerSpec> = {}): EnsureContainerSpec => ({
	name: 'devstack-owned',
	image: { digest: 'sha256:desired', tag: 'img:desired' },
	labels,
	recreate: 'on-failure',
	...overrides,
});

const inspectJson = (
	networks: Record<string, { IPAddress: string; Aliases?: ReadonlyArray<string> }> = {},
): string =>
	JSON.stringify([
		{
			Id: 'created-id',
			Image: 'sha256:desired',
			HostConfig: { PortBindings: {} },
			State: { Running: true, Paused: false, ExitCode: 0 },
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
			NetworkSettings: {
				Networks: Object.fromEntries(
					Object.entries(networks).map(([name, network]) => [
						name,
						{
							IPAddress: network.IPAddress,
							...(network.Aliases === undefined ? {} : { Aliases: network.Aliases }),
						},
					]),
				),
				Ports: {},
			},
		},
	]);

const writeDocker = (root: string, lines: ReadonlyArray<string>): { bin: string; log: string } => {
	const bin = join(root, 'docker');
	const log = join(root, 'docker.log');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
			'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then',
			'  shift',
			'fi',
			...lines,
		].join('\n'),
	);
	chmodSync(bin, 0o755);
	return { bin, log };
};

const stackPathsFor = (stackRoot: string): StackPaths => {
	const cacheDir = join(stackRoot, 'cache');
	const cacheNamespaceDir = (namespace: string): string => join(cacheDir, namespace);
	const cacheChainDir = (namespace: string, chain: string): string =>
		join(cacheNamespaceDir(namespace), chain);
	return {
		stackRoot,
		stateFile: join(stackRoot, 'state.json'),
		stateLockHint: join(stackRoot, 'state.json.lock'),
		cacheDir,
		snapshotDir: join(stackRoot, 'snapshots'),
		stackLockFile: join(stackRoot, 'stack.lock'),
		rosterFile: join(stackRoot, 'roster.json'),
		containerClaimsFile: join(stackRoot, 'container-claims.json'),
		snapshotReservationFile: join(stackRoot, 'snapshot.reservation'),
		cacheEntry: (namespace, chain, contentHash) => {
			const dir = cacheChainDir(namespace, chain);
			return { dir, file: join(dir, `${contentHash}.json`) };
		},
		cacheChainDir,
		cacheNamespaceDir,
	};
};

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

const stackPathsLayer = (stackRoot: string): Layer.Layer<StackPathsService> =>
	Layer.succeed(StackPathsService)(stackPathsFor(stackRoot));

describe('docker network-alias plumbing', () => {
	it.effect('emits --network-alias on docker run for primary attach aliases', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-net-alias-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const created = join(root, 'created');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ ! -f ${JSON.stringify(created)} ]; then`,
					'    echo "No such container" >&2',
					'    exit 1',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({ primary: { IPAddress: '172.18.0.2' } }),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ]; then',
					`  touch ${JSON.stringify(created)}`,
					'  printf "created-id\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "stop" ]; then exit 0; fi',
					'exit 0',
					'',
				]);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(
							baseSpec({
								networkAttach: [{ name: 'primary', aliases: ['db-main', 'db-replica'] }],
							}),
							{ cycle: 1, perNameLock },
						);
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				const runLine = readFileSync(log, 'utf8')
					.split('\n')
					.find((line) => line.startsWith('run '));
				expect(runLine).toBeDefined();
				expect(runLine).toContain('--network primary');
				expect(runLine).toContain('--network-alias db-main');
				expect(runLine).toContain('--network-alias db-replica');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('emits --alias on docker network connect for secondary attach aliases', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-net-alias-secondary-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const created = join(root, 'created');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ ! -f ${JSON.stringify(created)} ]; then`,
					'    echo "No such container" >&2',
					'    exit 1',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({
							primary: { IPAddress: '172.18.0.2' },
							secondary: { IPAddress: '172.19.0.2' },
						}),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ]; then',
					`  touch ${JSON.stringify(created)}`,
					'  printf "created-id\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "stop" ]; then exit 0; fi',
					'exit 0',
					'',
				]);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(
							baseSpec({
								networkAttach: ['primary', { name: 'secondary', aliases: ['side-a', 'side-b'] }],
							}),
							{ cycle: 1, perNameLock },
						);
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				const connectLine = readFileSync(log, 'utf8')
					.split('\n')
					.find((line) => line.startsWith('network connect '));
				expect(connectLine).toBeDefined();
				expect(connectLine).toContain('--alias side-a');
				expect(connectLine).toContain('--alias side-b');
				expect(connectLine).toContain('secondary devstack-owned');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('recreates an adopted container when primary network aliases drift', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-net-alias-drift-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const state = join(root, 'container-state');
				writeFileSync(state, 'old');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ ! -f ${JSON.stringify(state)} ]; then`,
					'    echo "No such container" >&2',
					'    exit 1',
					'  fi',
					`  if [ "$(cat ${JSON.stringify(state)})" = "old" ]; then`,
					`    printf '%s\\n' ${JSON.stringify(
						inspectJson({ primary: { IPAddress: '172.18.0.2', Aliases: ['devstack-owned'] } }),
					)}`,
					'    exit 0',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({ primary: { IPAddress: '172.18.0.2', Aliases: ['db-main'] } }),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "rm" ]; then',
					`  rm -f ${JSON.stringify(state)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ]; then',
					`  printf "new" > ${JSON.stringify(state)}`,
					'  printf "created-id\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "stop" ]; then exit 0; fi',
					'exit 0',
					'',
				]);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(
							baseSpec({
								recreate: 'on-config-change',
								networkAttach: [{ name: 'primary', aliases: ['db-main'] }],
							}),
							{ cycle: 1, perNameLock },
						);
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				const lines = readFileSync(log, 'utf8').split('\n');
				expect(lines.some((line) => line === 'rm -f devstack-owned')).toBe(true);
				const runLine = lines.find((line) => line.startsWith('run '));
				expect(runLine).toContain('--network-alias db-main');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
