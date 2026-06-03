import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import type { ContainerLabelTuple } from '../../src/contracts/snapshotable.ts';
import {
	runCapture,
	runRestore,
	snapshotIdFromString,
} from '../../src/orchestrators/snapshot/index.ts';
import { ContainerRuntimeService } from '../../src/runtime/docker/index.ts';
import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
import { readClaims } from '../../src/substrate/runtime/cross-process/roster.ts';
import { buildSubstrateLayers } from '../../src/orchestrators/run.ts';
import { StackPathsService } from '../../src/substrate/runtime/paths.ts';

const docker = (args: ReadonlyArray<string>, timeout = 60_000): SpawnSyncReturns<string> =>
	spawnSync('docker', [...args], { encoding: 'utf8', timeout });

const dockerReachable = (): { readonly ok: boolean; readonly detail: string } => {
	const res = docker(['info', '--format', '{{.ServerVersion}}'], 5_000);
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

const prepareImage = (
	sourceTag: string,
	targetTag: string,
):
	| { readonly ok: true; readonly digest: string }
	| { readonly ok: false; readonly detail: string } => {
	const pull = docker(['pull', sourceTag], 120_000);
	if (pull.status !== 0) {
		return { ok: false, detail: `docker pull ${sourceTag} failed: ${pull.stderr}` };
	}
	const tag = docker(['tag', sourceTag, targetTag]);
	if (tag.status !== 0) {
		return { ok: false, detail: `docker tag ${sourceTag} ${targetTag} failed: ${tag.stderr}` };
	}
	const inspect = docker(['image', 'inspect', '--format', '{{.Id}}', targetTag]);
	if (inspect.status !== 0) {
		return { ok: false, detail: `docker image inspect ${targetTag} failed: ${inspect.stderr}` };
	}
	return { ok: true, digest: inspect.stdout.trim() };
};

const snapshotTempTagsFor = (containerName: string): ReadonlyArray<string> => {
	const res = docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', 'devstack-snapshot']);
	if (res.status !== 0) return [];
	return res.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line.includes(containerName));
};

const cleanupDockerArtifacts = (containerName: string, imageTag: string): void => {
	docker(['rm', '-f', containerName], 20_000);
	for (const tag of snapshotTempTagsFor(containerName)) {
		docker(['image', 'rm', '-f', tag], 20_000);
	}
	docker(['image', 'rm', '-f', imageTag], 20_000);
};

describe('snapshot container image roundtrip', () => {
	it('replaces an active claimed container with the restored image state', async () => {
		const reachable = dockerReachable();
		if (!reachable.ok) {
			console.warn(`snapshot-container-image-roundtrip: skipping — ${reachable.detail}`);
			return;
		}

		const suffix = `${Date.now()}-${process.pid}`;
		const app = `snapshot-e2e-${suffix}`;
		const stack = 'main';
		const snapshotId = 'container-image-roundtrip';
		const containerName = `devstack-snapshot-e2e-${suffix}`;
		const imageTag = `devstack-snapshot-e2e:${suffix}`;
		const labels: ContainerLabelTuple = {
			app,
			stack,
			plugin: 'snapshot-e2e',
			role: 'state',
		};

		const image = prepareImage('busybox:1.36', imageTag);
		if (!image.ok) {
			throw new Error(image.detail);
		}

		const runtimeRoot = mkdtempSync(join(tmpdir(), 'snapshot-container-image-roundtrip-'));
		try {
			const identity = {
				app: appName(app),
				stack: stackName(stack),
				chain: chainId('sui:local'),
			};
			const spec = {
				name: containerName,
				image: { digest: image.digest, tag: imageTag },
				labels,
				recreate: 'on-failure' as const,
				entrypoint: 'sh',
				command: ['-c', 'while true; do sleep 60; done'] as const,
			};
			const participant = {
				plugin: 'snapshot-e2e',
				decl: {
					kind: 'snapshotable' as const,
					subtrees: [],
					managedContainers: [labels],
					missingTolerance: 'fine' as const,
				},
				captureIdentity: Effect.succeed({ 'snapshot-e2e': 'roundtrip' }),
				captureContribution: Effect.succeed({ marker: 'captured' }),
			};
			const restoreParticipant = {
				plugin: 'snapshot-e2e',
				liveIdentity: Effect.succeed({ 'snapshot-e2e': 'roundtrip' }),
			};

			const program = Effect.gen(function* () {
				const runtime = yield* ContainerRuntimeService;
				const paths = yield* StackPathsService;
				const artifactDir = join(paths.snapshotDir, snapshotId);
				const parsedSnapshotId = snapshotIdFromString(snapshotId);
				yield* Effect.sync(() => {
					mkdirSync(artifactDir, { recursive: true });
				});

				const marker = yield* Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* runtime.ensureContainer(spec);
						const claimsBeforeRestore = yield* readClaims({
							stackLockFile: paths.stackLockFile,
							rosterFile: paths.rosterFile,
							containerClaimsFile: paths.containerClaimsFile,
						});
						expect(claimsBeforeRestore.claims.map((claim) => claim.containerKey)).toContain(
							containerName,
						);
						const writeMarker = yield* runtime.exec(handle, [
							'sh',
							'-c',
							'printf captured > /snapshot-marker',
						]);
						expect(writeMarker.exitCode).toBe(0);

						const captured = yield* runCapture({
							stagingDir: artifactDir,
							snapshotId: parsedSnapshotId,
							label: null,
							app,
							stack,
							network: 'sui:local',
							runtimeStackRoot: paths.stackRoot,
							participants: [participant],
							runtime,
						});

						expect(captured.containers).toHaveLength(1);
						expect(captured.containers[0]?.imageName).toBe(imageTag);
						const tarPath = join(artifactDir, captured.containers[0]!.tarPath);
						expect(statSync(tarPath).size).toBeGreaterThan(0);

						const inspected = yield* runtime.inspectByLabels(labels);
						expect(inspected[0]?.status).toBe('running');
						expect(snapshotTempTagsFor(containerName)).toEqual([]);

						const dirtyMarker = yield* runtime.exec(handle, [
							'sh',
							'-c',
							'printf dirty > /snapshot-marker',
						]);
						expect(dirtyMarker.exitCode).toBe(0);

						const restored = yield* runRestore({
							snapshotId: parsedSnapshotId,
							artifactDir,
							runtimeStackRoot: paths.stackRoot,
							runtimeStagingPath: `${paths.stackRoot}.restore-staging`,
							runtimeBackupPath: `${paths.stackRoot}.restore-backup`,
							participants: [restoreParticipant],
							runtime,
							runtimeIdentity: { app, stack, network: 'sui:local' },
						});
						expect(restored.id).toBe(captured.id);
						expect(snapshotTempTagsFor(containerName)).toEqual([]);

						const afterReplace = yield* runtime.inspectByLabels(labels);
						expect(afterReplace).toEqual([]);

						const restoredHandle = yield* runtime.ensureContainer(spec);
						const readMarker = yield* runtime.exec(restoredHandle, ['cat', '/snapshot-marker']);
						expect(readMarker.exitCode).toBe(0);
						return readMarker.stdout;
					}),
				);
				expect(marker).toBe('captured');
			});

			await Effect.runPromise(
				program.pipe(Effect.provide(buildSubstrateLayers(identity, runtimeRoot))),
			);
		} finally {
			cleanupDockerArtifacts(containerName, imageTag);
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 180_000);
});
