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
	removeDevstackContainers,
	removeDevstackImages,
	removeDevstackNetworks,
	removeDevstackNetworksBestEffort,
	removeDevstackVolumes,
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
					const containerClaimsFile = join(root, 'container-claims.json');
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

					yield* addClaim(
						{ stackLockFile, rosterFile, containerClaimsFile },
						containerName,
					);
					const removed = yield* removeManagedContainers(labels).pipe(
						Effect.provide(fakeDockerLayer(bin)),
					);
					const claims = yield* readClaims({ stackLockFile, rosterFile, containerClaimsFile });
					const lines = readFileSync(log, 'utf8').trim().split('\n');

					expect(removed).toBe(1);
					expect(claims.claims.map((claim) => claim.containerKey)).toContain(containerName);
					expect(lines).toContain(`rm -f ${containerName}`);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
	);

	it.effect(
		'removes managed images, networks, and volumes through label-filtered inventory',
		() =>
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
		15_000,
	);

	it.effect(
		'removes pre-rewrite resources that only carry app and stack labels',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-remove-legacy-test-'));
				try {
					const bin = join(root, 'docker');
					const log = join(root, 'docker.log');
					const containerLine = JSON.stringify({
						ID: 'legacy-container',
						Names: 'legacy-arena-main-sui',
						Image: 'sui:test',
						Status: 'Exited',
						State: 'exited',
						Labels: 'devstack.app=arena,devstack.stack=main',
					});
					const foreignContainerLine = JSON.stringify({
						ID: 'legacy-foreign-container',
						Names: 'legacy-wallet-main-sui',
						Image: 'sui:test',
						Status: 'Exited',
						State: 'exited',
						Labels: 'devstack.app=wallet,devstack.stack=main',
					});
					const networkLine = JSON.stringify({
						ID: 'legacy-network',
						Name: 'legacy-arena-main-net',
						Driver: 'bridge',
						Labels: 'devstack.app=arena,devstack.stack=main',
					});
					const volumeLine = JSON.stringify({
						Name: 'legacy-arena-main-volume',
						Driver: 'local',
						Mountpoint: '/var/lib/docker/volumes/legacy-arena-main-volume/_data',
						Labels: 'devstack.app=arena,devstack.stack=main',
					});
					const imageLine = JSON.stringify({
						ID: 'legacy-image',
						Repository: 'legacy-arena',
						Tag: 'main',
						Labels: 'devstack.app=arena,devstack.stack=main',
					});
					writeFileSync(
						bin,
						[
							'#!/bin/sh',
							`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
							'if [ "$1" = "ps" ]; then',
							`  printf '%s\\n' ${JSON.stringify(containerLine)}`,
							`  printf '%s\\n' ${JSON.stringify(foreignContainerLine)}`,
							'  exit 0',
							'fi',
							'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then',
							`  printf '%s\\n' ${JSON.stringify(networkLine)}`,
							'  exit 0',
							'fi',
							'if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then',
							`  printf '%s\\n' ${JSON.stringify(volumeLine)}`,
							'  exit 0',
							'fi',
							'if [ "$1" = "images" ]; then',
							`  printf '%s\\n' ${JSON.stringify(imageLine)}`,
							'  exit 0',
							'fi',
							'if [ "$1" = "rm" ]; then',
							'  exit 0',
							'fi',
							'if [ "$1" = "network" ] && [ "$2" = "rm" ]; then',
							'  exit 0',
							'fi',
							'if [ "$1" = "volume" ] && [ "$2" = "rm" ]; then',
							'  exit 0',
							'fi',
							'if [ "$1" = "image" ] && [ "$2" = "rm" ]; then',
							'  exit 0',
							'fi',
							'exit 1',
							'',
						].join('\n'),
					);
					chmodSync(bin, 0o755);

					const match = { app: 'arena', stack: 'main' };
					const containers = yield* removeDevstackContainers(match).pipe(
						Effect.provide(fakeDockerLayer(bin)),
					);
					const networks = yield* removeDevstackNetworks(match).pipe(
						Effect.provide(fakeDockerLayer(bin)),
					);
					const volumes = yield* removeDevstackVolumes(match).pipe(
						Effect.provide(fakeDockerLayer(bin)),
					);
					const images = yield* removeDevstackImages(match).pipe(
						Effect.provide(fakeDockerLayer(bin)),
					);
					const lines = readFileSync(log, 'utf8').trim().split('\n');

					expect(containers).toBe(1);
					expect(networks).toBe(1);
					expect(volumes).toBe(1);
					expect(images).toBe(1);
					expect(lines).toContain('ps -a --format {{json .}} --filter label=devstack.app');
					expect(lines).toContain('rm -f legacy-arena-main-sui');
					expect(lines).not.toContain('rm -f legacy-wallet-main-sui');
					expect(lines).toContain('network rm legacy-arena-main-net');
					expect(lines).toContain('volume rm --force legacy-arena-main-volume');
					expect(lines).toContain('image rm -f legacy-arena:main');
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		15_000,
	);

	it.effect('reports active-endpoint networks as skipped for prune cleanup', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-remove-active-network-test-'));
			try {
				const bin = join(root, 'docker');
				const log = join(root, 'docker.log');
				const networkLine = JSON.stringify({
					ID: 'network-id',
					Name: 'seal-seal-net',
					Driver: 'bridge',
					Labels: 'devstack.app=seal-mini,devstack.stack=main',
				});
				writeFileSync(
					bin,
					[
						'#!/bin/sh',
						`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
						'if [ "$1" = "network" ] && [ "$2" = "ls" ]; then',
						`  printf '%s\\n' ${JSON.stringify(networkLine)}`,
						'  exit 0',
						'fi',
						'if [ "$1" = "network" ] && [ "$2" = "rm" ]; then',
						'  echo \'Error response from daemon: error while removing network: network seal-seal-net has active endpoints (name:"devstack-private-content-rewrite-main-seal-seal-key-server" id:"58dd")\' >&2',
						'  exit 1',
						'fi',
						'exit 1',
						'',
					].join('\n'),
				);
				chmodSync(bin, 0o755);

				const result = yield* removeDevstackNetworksBestEffort(
					{ app: 'seal-mini', stack: 'main' },
					{ retryAttempts: 1, retryDelayMillis: 0 },
				).pipe(Effect.provide(fakeDockerLayer(bin)));
				const lines = readFileSync(log, 'utf8').trim().split('\n');

				expect(result.removed).toBe(0);
				expect(result.skippedInUse).toBe(1);
				// Foreign holders depend on what the shim reports for
				// `network inspect`. This shim doesn't expose attachments,
				// so the holder list should be empty.
				expect(result.foreignHolders).toEqual([]);
				// The shim's "active endpoints" stderr names a phantom
				// endpoint — that's the stale-endpoint signature.
				expect(result.staleEndpoints).toEqual([
					{
						network: 'seal-seal-net',
						name: 'devstack-private-content-rewrite-main-seal-seal-key-server',
						id: '58dd',
					},
				]);
				expect(lines).toContain('network rm seal-seal-net');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
