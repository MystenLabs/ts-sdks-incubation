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
	decideRunAction,
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
		readonly portBindings?: unknown;
		readonly effectivePorts?: unknown;
		readonly includeTopLevelImage?: boolean;
		readonly includeConfigImage?: boolean;
		readonly includeHostConfig?: boolean;
		readonly includeState?: boolean;
	} = {},
): string =>
	JSON.stringify([
		{
			Id: overrides.id ?? 'container-id',
			...(overrides.includeTopLevelImage === false ? {} : { Image: 'sha256:desired' }),
			...(overrides.includeHostConfig === false
				? {}
				: { HostConfig: { PortBindings: overrides.portBindings ?? {} } }),
			...(overrides.includeState === false
				? {}
				: {
						State: {
							Running: overrides.running ?? true,
							Paused: overrides.paused ?? false,
							ExitCode: overrides.exitCode ?? 0,
						},
					}),
			Config: {
				...(overrides.includeConfigImage === false ? {} : { Image: 'img:desired' }),
				Labels: overrides.labels ?? ownedDockerLabels,
			},
			NetworkSettings: {
				Networks: overrides.networks ?? {},
				Ports: overrides.effectivePorts ?? {},
			},
		},
	]);

const portBindings = (
	rpcHostPort: number,
	faucetHostPort: number,
): Record<string, ReadonlyArray<{ readonly HostIp: string; readonly HostPort: string }>> => ({
	'9000/tcp': [{ HostIp: '0.0.0.0', HostPort: String(rpcHostPort) }],
	'9123/tcp': [{ HostIp: '0.0.0.0', HostPort: String(faucetHostPort) }],
});

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
		containerClaimsFile: join(stackRoot, 'container-claims.json'),
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
		[
			'#!/bin/sh',
			`printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
			'CONTAINER_INSPECT=0',
			'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then',
			'  CONTAINER_INSPECT=1',
			'  shift',
			'fi',
			...lines,
		].join('\n'),
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

	it.effect('treats Docker 29 no-such-object inspect exits as missing containers', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-nosuch-object-test-'));
			try {
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					'  echo "Error: No such object: devstack-owned" >&2',
					'  exit 1',
					'fi',
					'exit 0',
					'',
				]);

				const facts = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(facts).toBe(null);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('does not decode a same-name Docker network as a container', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-type-specific-test-'));
			try {
				const { bin, log } = writeDocker(root, [
					'if [ "$CONTAINER_INSPECT" = "1" ]; then',
					'  echo "Error: No such container: devstack-owned" >&2',
					'  exit 1',
					'fi',
					'if [ "$1" = "inspect" ]; then',
					'  printf "%s\\n" \'[{"Id":"network-id","Name":"devstack-owned","Labels":{"devstack.managed":"true","devstack.network":"true"}}]\'',
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const facts = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(facts).toBe(null);
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toEqual(['container inspect devstack-owned']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('uses Config.Image when Docker inspect omits the top-level Image field', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-no-top-image-test-'));
			try {
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(inspectJson({ includeTopLevelImage: false }))}`,
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const facts = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(facts?.image).toBe('img:desired');
				expect(facts?.imageDigest).toBeUndefined();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('records Docker inspect top-level Image as the image digest', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-image-digest-test-'));
			try {
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(inspectJson())}`,
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const facts = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(facts?.image).toBe('img:desired');
				expect(facts?.imageDigest).toBe('sha256:desired');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('uses NetworkSettings.Ports when Docker inspect omits top-level HostConfig', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-no-host-config-test-'));
			try {
				const publishedPorts = portBindings(51001, 50001);
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({
							includeHostConfig: false,
							effectivePorts: publishedPorts,
						}),
					)}`,
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const facts = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(facts?.portBindings).toEqual(['9000/tcp=0.0.0.0:51001', '9123/tcp=0.0.0.0:50001']);
				expect(facts?.effectivePortBindings).toEqual(facts?.portBindings);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('records missing Docker inspect State as unknown lifecycle evidence', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-inspect-no-state-test-'));
			try {
				const publishedPorts = portBindings(51001, 50001);
				const { bin } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({
							includeTopLevelImage: false,
							includeHostConfig: false,
							includeState: false,
							effectivePorts: publishedPorts,
						}),
					)}`,
					'  exit 0',
					'fi',
					'exit 0',
					'',
				]);

				const facts = yield* inspectContainer('devstack-owned').pipe(
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(facts?.lifecycle).toEqual({ kind: 'unknown' });
				expect(facts?.running).toBe(false);
				expect(facts?.paused).toBe(false);
				expect(facts?.exitCode).toBe(null);
				expect(facts?.image).toBe('img:desired');
				expect(facts?.portBindings).toEqual(['9000/tcp=0.0.0.0:51001', '9123/tcp=0.0.0.0:50001']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect(
		'fails inspect output that omits Config.Image because lifecycle decisions need it',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-inspect-no-config-image-test-'));
				try {
					const { bin } = writeDocker(root, [
						'if [ "$1" = "inspect" ]; then',
						`  printf '%s\\n' ${JSON.stringify(
							inspectJson({ includeTopLevelImage: false, includeConfigImage: false }),
						)}`,
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
});

describe('container lifecycle decisions', () => {
	it('recreates or refuses when inspect cannot prove lifecycle state', () => {
		const facts = {
			id: 'unknown-id',
			lifecycle: { kind: 'unknown' },
			running: false,
			paused: false,
			exitCode: null,
			image: 'img:desired',
			portBindings: [],
		} as const;

		expect(decideRunAction(facts, 'img:desired', 'on-failure')).toEqual({
			kind: 'recreate',
			id: 'unknown-id',
			reason: 'unknown-state',
		});
		expect(decideRunAction(facts, 'img:desired', 'on-config-change')).toEqual({
			kind: 'recreate',
			id: 'unknown-id',
			reason: 'unknown-state',
		});
		expect(decideRunAction(facts, 'img:desired', 'never')).toEqual({
			kind: 'refuse',
			reason: 'unknown-state',
		});
	});

	it('treats a caller-supplied config hash mismatch as config drift', () => {
		const facts = {
			id: 'running-id',
			lifecycle: { kind: 'running', exitCode: 0 },
			running: true,
			paused: false,
			exitCode: 0,
			image: 'img:desired',
			portBindings: [],
			labels: { ...ownedDockerLabels, 'devstack.config-hash': 'old' },
		} as const;

		expect(decideRunAction(facts, 'img:desired', 'on-config-change', [], 'exact', 'new')).toEqual({
			kind: 'recreate',
			id: 'running-id',
			reason: 'config-mismatch',
		});
		expect(
			decideRunAction(
				{ ...facts, labels: { ...ownedDockerLabels, 'devstack.config-hash': 'new' } },
				'img:desired',
				'on-config-change',
				[],
				'exact',
				'new',
			),
		).toEqual({ kind: 'adopt', id: 'running-id' });
	});

	it('adopts and resumes when only the image tag changed but the image digest still matches', () => {
		const runningFacts = {
			id: 'running-id',
			lifecycle: { kind: 'running', exitCode: 0 },
			running: true,
			paused: false,
			exitCode: 0,
			image: 'devstack-build:old-tag',
			imageDigest: 'sha256:desired',
			portBindings: [],
		} as const;

		expect(
			decideRunAction(
				runningFacts,
				'devstack-build:new-tag',
				'on-failure',
				[],
				'exact',
				undefined,
				'sha256:desired',
			),
		).toEqual({ kind: 'adopt', id: 'running-id' });

		expect(
			decideRunAction(
				{
					...runningFacts,
					id: 'stopped-id',
					lifecycle: { kind: 'stopped', exitCode: 0 },
					running: false,
				},
				'devstack-build:new-tag',
				'on-failure',
				[],
				'exact',
				undefined,
				'sha256:desired',
			),
		).toEqual({ kind: 'resume', id: 'stopped-id' });
	});
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
				expect(lines).toEqual(['container inspect devstack-owned']);
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

describe('container lifecycle mutation policy', { timeout: 30_000 }, () => {
	it.effect(
		'recreates a matching container when inspect cannot prove its lifecycle state',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'docker-unknown-state-recreate-test-'));
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
							inspectJson({ id: 'unknown-state-id', includeState: false }),
						)}`,
						'  exit 0',
						'fi',
						'if [ "$1" = "rm" ]; then exit 0; fi',
						'if [ "$1" = "run" ]; then',
						`  touch ${JSON.stringify(created)}`,
						'  printf "created-id\\n"',
						'  exit 0',
						'fi',
						'if [ "$1" = "start" ]; then',
						'  echo "unexpected start" >&2',
						'  exit 1',
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
					expect(lines).toContain('rm -f devstack-owned');
					expect(lines.some((line) => line.startsWith('run -d --name devstack-owned'))).toBe(true);
					expect(lines.some((line) => line.startsWith('start '))).toBe(false);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}),
		{ timeout: 30_000 },
	);

	it.effect('refuses collision recovery when the remaining container lifecycle is unknown', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-unknown-state-collision-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({ id: 'unknown-state-id', includeState: false }),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "rm" ]; then',
					'  echo "device or resource busy" >&2',
					'  exit 1',
					'fi',
					'if [ "$1" = "run" ]; then',
					'  echo "Conflict. The container name is already in use by container unknown-state-id" >&2',
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
						return yield* ensureContainer(spec({ recreate: 'on-failure' }), {
							cycle: 1,
							perNameLock,
						});
					}),
				).pipe(
					Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))),
					Effect.exit,
				);

				const error = expectErrorTag(exit, 'ContainerNameCollisionUnrecoverable') as
					| { readonly detail: string }
					| undefined;
				expect(error?.detail).toContain('unknown lifecycle state before-start');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain('rm -f devstack-owned');
				expect(lines.some((line) => line.startsWith('run -d --name devstack-owned'))).toBe(true);
				expect(lines.some((line) => line.startsWith('start '))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

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

	it.effect('repairs a resumed container whose Docker port publishes are not effective', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-resume-stale-ports-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const created = join(root, 'created');
				const inspectCount = join(root, 'inspect-count');
				const configuredPorts = portBindings(51001, 50001);
				const activePorts = portBindings(51002, 50002);
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ -f ${JSON.stringify(created)} ]; then`,
					`    printf '%s\\n' ${JSON.stringify(
						inspectJson({
							id: 'created-id',
							portBindings: activePorts,
							effectivePorts: activePorts,
							networks: { bridge: { IPAddress: '172.17.0.2' } },
						}),
					)}`,
					'    exit 0',
					'  fi',
					`  count=$(cat ${JSON.stringify(inspectCount)} 2>/dev/null || printf 0)`,
					'  count=$((count + 1))',
					`  printf '%s' "$count" > ${JSON.stringify(inspectCount)}`,
					'  if [ "$count" -le 2 ]; then',
					`    printf '%s\\n' ${JSON.stringify(
						inspectJson({
							running: false,
							exitCode: 0,
							id: 'stopped-id',
							portBindings: configuredPorts,
						}),
					)}`,
					'    exit 0',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(
						inspectJson({
							id: 'stopped-id',
							portBindings: configuredPorts,
							effectivePorts: { '9000/tcp': [], '9123/tcp': [] },
						}),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "start" ]; then exit 0; fi',
					'if [ "$1" = "rm" ]; then exit 0; fi',
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
						return yield* ensureContainer(
							spec({
								recreate: 'on-config-change',
								portBindingReconciliation: 'adopt-existing',
								ports: [
									{ containerPort: 9000, hostPort: 51001, hostIp: '0.0.0.0' },
									{ containerPort: 9123, hostPort: 50001, hostIp: '0.0.0.0' },
								],
							}),
							{ cycle: 1, perNameLock },
						);
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				expect(handle.id).toBe('created-id');
				expect(handle.ports).toEqual([
					{ containerPort: 9000, hostPort: 51002, hostIp: '0.0.0.0' },
					{ containerPort: 9123, hostPort: 50002, hostIp: '0.0.0.0' },
				]);
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain('start devstack-owned');
				expect(lines).toContain('rm -f devstack-owned');
				expect(lines.some((line) => line.startsWith('run -d --name devstack-owned'))).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('takes fresh-create path when initial Docker 29 inspect reports no such object', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-fresh-nosuch-object-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const created = join(root, 'created');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ ! -f ${JSON.stringify(created)} ]; then`,
					'    echo "error: no such object: devstack-owned" >&2',
					'    exit 1',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(inspectJson({ id: 'created-id' }))}`,
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
						return yield* ensureContainer(spec(), { cycle: 1, perNameLock });
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				expect(handle.id).toBe('created-id');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines[0]).toBe('container inspect devstack-owned');
				expect(lines.some((line) => line.startsWith('run -d --name devstack-owned'))).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('uses per-spec stop grace when the scope finalizer stops a live container', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'docker-stop-grace-test-'));
			try {
				const stackRoot = join(root, 'stack');
				mkdirSync(stackRoot, { recursive: true });
				const created = join(root, 'created');
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "inspect" ]; then',
					`  if [ ! -f ${JSON.stringify(created)} ]; then`,
					'    echo "Error: No such container: devstack-owned" >&2',
					'    exit 1',
					'  fi',
					`  printf '%s\\n' ${JSON.stringify(inspectJson({ id: 'created-id' }))}`,
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
						return yield* ensureContainer(spec({ stopGraceSeconds: 30 }), {
							cycle: 1,
							perNameLock,
						});
					}),
				).pipe(Effect.provide(Layer.mergeAll(fakeDockerLayer(bin), stackPathsLayer(stackRoot))));

				expect(handle.id).toBe('created-id');
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain('stop --time 30 devstack-owned');
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
				expect(lines).toEqual(['container inspect devstack-owned']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);
});
