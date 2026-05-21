import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Ref } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import type {
	ContainerHandle,
	EnsureContainerSpec,
} from '../../../src/contracts/container-runtime.ts';
import type { ContainerLabelTuple } from '../../../src/contracts/snapshotable.ts';
import {
	DockerSpawner,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/client.ts';
import {
	ensureContainer,
	inspectContainer,
	type PerNameLockState,
} from '../../../src/runtime/docker/container.ts';
import { ensureNetwork } from '../../../src/runtime/docker/network.ts';
import {
	ContainerRuntimeService,
	layerContainerRuntimeDocker,
	layerDockerCycleInitial,
} from '../../../src/runtime/docker/service.ts';
import { ensureVolume } from '../../../src/runtime/docker/volume.ts';
import { CacheService } from '../../../src/substrate/runtime/cache/index.ts';
import { StackPathsService, type StackPaths } from '../../../src/substrate/runtime/paths.ts';

const ownedLabels: ContainerLabelTuple = {
	app: 'app',
	stack: 'main',
	plugin: 'postgres',
	role: 'db',
};

const ownedDockerLabels = {
	'devstack.managed': 'true',
	'devstack.app': 'app',
	'devstack.stack': 'main',
	'devstack.plugin': 'postgres',
	'devstack.role': 'db',
};

const foreignDockerLabels = {
	'devstack.managed': 'true',
	'devstack.app': 'other',
	'devstack.stack': 'main',
	'devstack.plugin': 'postgres',
	'devstack.role': 'db',
};

const spec = (overrides: Partial<EnsureContainerSpec> = {}): EnsureContainerSpec => ({
	name: 'devstack-owned',
	image: { digest: 'sha256:desired', tag: 'img:desired' },
	labels: ownedLabels,
	recreate: 'on-failure',
	...overrides,
});

const inspectJson = (
	overrides: {
		readonly id?: string;
		readonly running?: boolean;
		readonly paused?: boolean;
		readonly exitCode?: number;
		readonly labels?: Readonly<Record<string, string>>;
		readonly networks?: unknown;
	} = {},
): string =>
	JSON.stringify([
		{
			Id: overrides.id ?? 'container-id',
			Image: 'sha256:desired',
			HostConfig: { PortBindings: {} },
			State: {
				Running: overrides.running ?? true,
				Paused: overrides.paused ?? false,
				ExitCode: overrides.exitCode ?? 0,
			},
			Config: {
				Image: 'img:desired',
				Labels: overrides.labels ?? ownedDockerLabels,
			},
			NetworkSettings: {
				Networks: overrides.networks ?? {},
			},
		},
	]);

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

const writeDocker = (root: string, lines: ReadonlyArray<string>): { bin: string; log: string } => {
	const bin = join(root, 'docker');
	const log = join(root, 'docker.log');
	writeFileSync(
		bin,
		['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, ...lines].join('\n'),
	);
	chmodSync(bin, 0o755);
	return { bin, log };
};

const expectErrorTag = <Tag extends string>(
	exit: Exit.Exit<unknown, unknown>,
	tag: Tag,
): unknown => {
	expect(Exit.isFailure(exit)).toBe(true);
	const error = Exit.findErrorOption(exit);
	expect(error._tag).toBe('Some');
	if (error._tag === 'Some') {
		expect((error.value as { readonly _tag?: string })._tag).toBe(tag);
		return error.value;
	}
	return undefined;
};

describe('docker inspect ownership boundary', () => {
	it.effect('returns null only for not-found and fails non-notfound inspect exits', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-failure-test-'));
			try {
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					'  echo "permission denied" >&2',
					'  exit 1',
					'fi',
					'exit 0',
					'',
				]);

				const exit = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
					Effect.exit,
				);

				expectErrorTag(exit, 'DockerInspectFailed');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('fails malformed inspect JSON instead of treating it as missing', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-decode-test-'));
			try {
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					'  printf "not-json\\n"',
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const exit = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
					Effect.exit,
				);

				expectErrorTag(exit, 'DockerInspectDecodeFailed');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('keeps daemon-unreachable inspect exits distinct from decode and not-found', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-daemon-test-'));
			try {
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					'  echo "Cannot connect to the Docker daemon" >&2',
					'  exit 1',
					'fi',
					'exit 0',
					'',
				]);

				const exit = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
					Effect.exit,
				);

				expectErrorTag(exit, 'DaemonUnreachable');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});

describe('same-name Docker resource ownership', () => {
	it.effect('refuses a foreign same-name container before mutation', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-foreign-container-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(inspectJson({ labels: foreignDockerLabels }))}`,
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const exit = yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(spec(), { cycle: 1, perNameLock });
					}),
				).pipe(
					Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))),
					Effect.exit,
				);

				expectErrorTag(exit, 'ForeignDockerResource');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toEqual(['inspect devstack-owned']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('does not start a foreign container after fresh-create name collision', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-collision-foreign-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const countFile = join(root, 'inspect-count');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  count=$(cat ${JSON.stringify(countFile)} 2>/dev/null || printf 0)`,
					'  count=$((count + 1))',
					`  printf '%s' "$count" > ${JSON.stringify(countFile)}`,
					'  if [ "$count" = "1" ]; then',
					'    echo "No such container" >&2',
					'    exit 1',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(inspectJson({ labels: foreignDockerLabels }))}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ]; then',
					'  echo "Conflict. The container name is already in use by container abc" >&2',
					'  exit 125',
					'fi',
					'if [ "$1" = "start" ]; then',
					'  echo "unexpected start" >&2',
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const exit = yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(spec(), { cycle: 1, perNameLock });
					}),
				).pipe(
					Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))),
					Effect.exit,
				);

				expectErrorTag(exit, 'ForeignDockerResource');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines.some((line) => line.startsWith('start '))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('refuses foreign same-name networks and volumes', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-foreign-resource-test-'));
			try {
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then',
					'  printf "%s\\n" \'[{"Id":"network-id","Labels":{"devstack.managed":"true","devstack.network":"true","devstack.app":"other","devstack.stack":"main"}}]\'',
					'  exit 0',
					'fi',
					'if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then',
					'  printf "%s\\n" \'[{"Name":"devstack-volume","Labels":{"devstack.managed":"true","devstack.volume":"true","devstack.app":"other","devstack.stack":"main","devstack.plugin":"postgres","devstack.role":"db"}}]\'',
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const networkExit = yield* ensureNetwork('devstack-network', {
					app: 'app',
					stack: 'main',
				}).pipe(Effect.provide(fakeDockerLayer(bin)), Effect.exit);
				const volumeExit = yield* ensureVolume('devstack-volume', ownedLabels).pipe(
					Effect.provide(fakeDockerLayer(bin)),
					Effect.exit,
				);

				expectErrorTag(networkExit, 'ForeignDockerResource');
				expectErrorTag(volumeExit, 'ForeignDockerResource');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).not.toContain('network create devstack-network');
				expect(lines).not.toContain('volume create devstack-volume');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});

describe('container lifecycle mutation policy', () => {
	it.effect('treats secondary network already-attached stderr as successful connect', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-secondary-network-test-'));
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
							id: 'created-id',
							networks: {
								primary: { IPAddress: '172.18.0.2' },
								secondary: { IPAddress: '172.19.0.2' },
							},
						}),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ]; then',
					`  touch ${JSON.stringify(created)}`,
					'  printf "created-id\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "network" ] && [ "$2" = "connect" ]; then',
					'  echo "endpoint with name devstack-owned already exists in network secondary" >&2',
					'  exit 1',
					'fi',
					'if [ "$1" = "stop" ]; then exit 0; fi',
					'exit 0',
					'',
				]);

				const handle = yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(spec({ networkAttach: ['primary', 'secondary'] }), {
							cycle: 1,
							perNameLock,
						});
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				expect(handle.ips).toEqual(['172.18.0.2', '172.19.0.2']);
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain('network connect secondary devstack-owned');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('routes resume start failure through recreate policy refusal', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-resume-refuse-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({ running: false, exitCode: 0, id: 'stopped-id' }),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "start" ]; then',
					'  echo "port is already allocated" >&2',
					'  exit 1',
					'fi',
					'if [ "$1" = "rm" ] || [ "$1" = "run" ]; then',
					'  echo "unexpected recreate" >&2',
					'  exit 1',
					'fi',
					'exit 0',
					'',
				]);

				const exit = yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(spec({ recreate: 'never' }), {
							cycle: 1,
							perNameLock,
						});
					}),
				).pipe(
					Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))),
					Effect.exit,
				);

				const error = expectErrorTag(exit, 'RecreateRefused') as
					| { readonly reason: string }
					| undefined;
				expect(error?.reason).toBe('resume-failed');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain('start devstack-owned');
				expect(lines.some((line) => line.startsWith('rm '))).toBe(false);
				expect(lines.some((line) => line.startsWith('run '))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('routes resume start failure through recreate when policy allows it', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-resume-recreate-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const created = join(root, 'created');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ -f ${JSON.stringify(created)} ]; then`,
					`    printf '%s\\n' ${JSON.stringify(inspectJson({ id: 'created-id' }))}`,
					'    exit 0',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({ running: false, exitCode: 0, id: 'stopped-id' }),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "start" ]; then',
					'  echo "port is already allocated" >&2',
					'  exit 1',
					'fi',
					'if [ "$1" = "rm" ]; then',
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

				const handle = yield* Effect.scoped(
					Effect.gen(function* () {
						const perNameLock = yield* Ref.make<PerNameLockState>(new Map());
						return yield* ensureContainer(spec({ recreate: 'on-failure' }), {
							cycle: 1,
							perNameLock,
						});
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				expect(handle.id).toBe('created-id');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain('start devstack-owned');
				expect(lines).toContain('rm -f devstack-owned');
				expect(lines.some((line) => line.startsWith('run -d --name devstack-owned'))).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('rechecks handle labels before contract exec mutates by stable name', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-exec-foreign-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(inspectJson({ labels: foreignDockerLabels }))}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "exec" ]; then',
					'  echo "unexpected exec" >&2',
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);
				const handle: ContainerHandle = {
					id: 'container-id',
					name: 'devstack-owned',
					labels: ownedLabels,
					imageName: 'img:desired',
					status: 'running',
					ips: [],
				};

				const exit = yield* Effect.gen(function* () {
					const runtime = yield* ContainerRuntimeService;
					return yield* runtime.exec(handle, ['true']);
				}).pipe(Effect.provide(dockerRuntimeLayer(bin, stackRoot)), Effect.exit);

				const error = expectErrorTag(exit, 'ContainerRuntimeError') as
					| { readonly reason: string }
					| undefined;
				expect(error?.reason).toBe('foreign-resource');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toEqual(['inspect devstack-owned']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
