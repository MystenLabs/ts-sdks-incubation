import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import {
	DockerSpawner,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/client.ts';
import {
	removeManagedContainers,
	removeManagedImages,
	removeManagedNetworks,
	removeManagedVolumes,
} from '../../../src/runtime/docker/sweep.ts';
import { addClaim, readClaims } from '../../../src/substrate/runtime/cross-process/roster.ts';

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

describe('removeManagedContainers', () => {
	it.effect(
		'removes matching managed containers even when the claim ledger contains the name',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-replace-managed-test-'));
				try {
					const bin = join(root, 'docker');
					const log = join(root, 'docker.log');
					const stackLockFile = join(root, 'stack.lock');
					const rosterFile = join(root, 'roster.json');
					const containerName = 'devstack-claimed-postgres';
					const labels: ContainerLabelTuple = {
						app: 'app',
						stack: 'main',
						plugin: 'postgres',
						role: 'db',
					};
					const psLine = JSON.stringify({
						ID: 'container-id',
						Names: containerName,
						Image: 'postgres:test',
						Status: 'Up 1 second',
						State: 'running',
						Labels:
							'devstack.managed=true,devstack.app=app,devstack.stack=main,devstack.plugin=postgres,devstack.role=db',
					});
					writeFileSync(
						bin,
						[
							'#!/bin/sh',
							`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
							'if [ "$1" = "ps" ]; then',
							`  printf '%s\\n' ${JSON.stringify(psLine)}`,
							'  exit 0',
							'fi',
							'if [ "$1" = "rm" ]; then',
							'  exit 0',
							'fi',
							'exit 1',
							'',
						].join('\n'),
					);
					chmodSync(bin, 0o755);

					yield* addClaim({ stackLockFile, rosterFile }, containerName);
					const removed = yield* removeManagedContainers(labels).pipe(
						Effect.provide(fakeDockerLayer(bin)),
					);
					const claims = yield* readClaims({ stackLockFile, rosterFile });
					const lines = readFileSync(log, 'utf8').trim().split('\n');

					expect(removed).toBe(1);
					expect(claims.claims.map((claim) => claim.containerKey)).toContain(containerName);
					expect(lines).toContain(`rm -f ${containerName}`);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
	);

	it.effect('removes managed images, networks, and volumes through label-filtered inventory', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-remove-managed-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				const labels = {
					app: 'app',
					stack: 'main',
				};
				const imageLine = JSON.stringify({
					ID: 'sha256:managed-image',
					Repository: 'devstack-snapshot',
					Tag: 'postgres-db',
					Labels:
						'devstack.managed=true,devstack.app=app,devstack.stack=main,devstack.plugin=postgres,devstack.role=db',
				});
				const networkLine = JSON.stringify({
					ID: 'network-id',
					Name: 'devstack-app-main',
					Driver: 'bridge',
					Labels:
						'devstack.managed=true,devstack.network=true,devstack.app=app,devstack.stack=main',
				});
				const unmarkedNetworkLine = JSON.stringify({
					ID: 'foreign-network-id',
					Name: 'devstack-foreign',
					Driver: 'bridge',
					Labels: 'devstack.managed=true,devstack.app=app,devstack.stack=main',
				});
				const volumeLine = JSON.stringify({
					Name: 'devstack-app-main-postgres',
					Driver: 'local',
					Mountpoint: '/var/lib/docker/volumes/devstack-app-main-postgres/_data',
					Labels:
						'devstack.managed=true,devstack.volume=true,devstack.app=app,devstack.stack=main,devstack.plugin=postgres,devstack.role=db',
				});
				const unmarkedVolumeLine = JSON.stringify({
					Name: 'devstack-foreign-volume',
					Driver: 'local',
					Mountpoint: '/var/lib/docker/volumes/devstack-foreign-volume/_data',
					Labels: 'devstack.managed=true,devstack.app=app,devstack.stack=main',
				});
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "images" ]; then',
						`  printf '%s\\n' ${JSON.stringify(imageLine)}`,
						'  exit 0',
						'fi',
						'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then',
						`  printf '%s\\n' ${JSON.stringify(networkLine)}`,
						`  printf '%s\\n' ${JSON.stringify(unmarkedNetworkLine)}`,
						'  exit 0',
						'fi',
						'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then',
						`  printf '%s\\n' ${JSON.stringify(volumeLine)}`,
						`  printf '%s\\n' ${JSON.stringify(unmarkedVolumeLine)}`,
						'  exit 0',
						'fi',
						'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'if [ "$1" = "network" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then',
						'  exit 0',
						'fi',
						'exit 1',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				const images = yield* removeManagedImages(labels).pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);
				const networks = yield* removeManagedNetworks(labels).pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);
				const volumes = yield* removeManagedVolumes(labels).pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);
				const lines = readFileSync(log, 'utf8').trim().split('\n');

				expect(images).toBe(1);
				expect(networks).toBe(1);
				expect(volumes).toBe(1);
				expect(lines).toContain(
					'images --format {{json .}} --filter label=devstack.managed=true --filter label=devstack.app=app --filter label=devstack.stack=main',
				);
				expect(lines).toContain('image rm -f devstack-snapshot:postgres-db');
				expect(lines).toContain('network rm devstack-app-main');
				expect(lines).not.toContain('network rm devstack-foreign');
				expect(lines).toContain('volume rm --force devstack-app-main-postgres');
				expect(lines).not.toContain('volume rm --force devstack-foreign-volume');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
