import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Effect, Layer } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { describe, expect, it } from '@effect/vitest';

import {
	ROUTER_CONTAINER_SPEC_VERSION,
	ROUTER_KIND_LABEL_VALUE,
	ROUTER_PROFILE_LABEL,
	TRAEFIK_DISPATCH_MOUNT_TARGET,
	layerTraefikContainerOpsDocker,
	routerProfileLabelsMatch,
	traefikExpectedCommand,
	traefikExpectedPortBindings,
	TraefikContainerOpsService,
	bootstrap,
	type InspectedTraefikContainer,
	type TraefikContainerOps,
} from '../../../src/orchestrators/router/traefik-container.ts';
import {
	ComposeLabelKey,
	DockerSpawner,
	LabelKey,
	layerDockerHost,
	type DockerHost,
} from '../../../src/runtime/docker/index.ts';
import type { Entrypoint } from '../../../src/orchestrators/router/entrypoints.ts';
import type { RouterProfile } from '../../../src/orchestrators/router/profile.ts';

const profile: RouterProfile = {
	version: 1,
	id: 'test-profile',
	userId: 'test-user',
	dockerContextId: 'test-docker',
	stateDir: '/Users/test/.devstack/router/test-profile',
	dispatchDir: '/Users/test/.devstack/router/test-profile/dispatch',
	containerName: 'devstack-router-test-profile',
	networkName: 'devstack-router-test-profile',
	bootstrapLockFile: '/Users/test/.devstack/router/test-profile/locks/bootstrap.lock',
	dispatchLockFile: '/Users/test/.devstack/router/test-profile/locks/dispatch.lock',
};

const dispatchDir = profile.dispatchDir;

type ExistingRouterContainer = InspectedTraefikContainer | null;

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

const dockerPortBindingsFor = (
	entrypoints: ReadonlyArray<Entrypoint>,
): Record<string, ReadonlyArray<{ readonly HostIp: string; readonly HostPort: string }>> =>
	Object.fromEntries(
		[...new Set(entrypoints.map((entrypoint) => entrypoint.port))]
			.sort((a, b) => a - b)
			.map((port) => [`${port}/tcp`, [{ HostIp: '127.0.0.1', HostPort: String(port) }]]),
	);

const matchingDockerInspectJson = (
	entrypoints: ReadonlyArray<Entrypoint>,
	options: { readonly includeHostConfig?: boolean; readonly includeState?: boolean } = {},
): string => {
	const ports = dockerPortBindingsFor(entrypoints);
	return JSON.stringify([
		{
			Id: 'router-id',
			Mounts: [
				{
					Source: dispatchDir,
					Destination: TRAEFIK_DISPATCH_MOUNT_TARGET,
					RW: false,
				},
			],
			...(options.includeHostConfig === false ? {} : { HostConfig: { PortBindings: ports } }),
			...(options.includeState === false
				? {}
				: { State: { Running: true, Paused: false, ExitCode: 0 } }),
			Config: {
				Image: 'traefik:v3.5',
				Cmd: traefikExpectedCommand(entrypoints),
				Labels: {
					[LabelKey.managed]: 'true',
					[LabelKey.kind]: ROUTER_KIND_LABEL_VALUE,
					[ROUTER_PROFILE_LABEL]: profile.id,
					[LabelKey.specVersion]: ROUTER_CONTAINER_SPEC_VERSION,
				},
			},
			NetworkSettings: {
				Networks: { [profile.networkName]: { IPAddress: '172.20.0.2' } },
				Ports: ports,
			},
		},
	]);
};

const matchingRouterNetworkJson = (): string =>
	JSON.stringify([
		{
			Id: 'network-id',
			Labels: {
				[LabelKey.managed]: 'true',
				[LabelKey.networkMarker]: 'true',
				[LabelKey.app]: 'devstack-router',
				[LabelKey.stack]: profile.networkName,
			},
		},
	]);

const matchingExisting = (
	entrypoints: ReadonlyArray<Entrypoint>,
	overrides: Partial<InspectedTraefikContainer> = {},
): InspectedTraefikContainer => ({
	id: 'existing-id',
	running: true,
	image: 'traefik:v3.5',
	dispatchMount: {
		source: dispatchDir,
		target: TRAEFIK_DISPATCH_MOUNT_TARGET,
		readOnly: true,
	},
	portBindings: traefikExpectedPortBindings(entrypoints),
	command: traefikExpectedCommand(entrypoints),
	networks: [profile.networkName],
	labels: {
		[LabelKey.managed]: 'true',
		[LabelKey.kind]: ROUTER_KIND_LABEL_VALUE,
		[ROUTER_PROFILE_LABEL]: profile.id,
		[LabelKey.specVersion]: ROUTER_CONTAINER_SPEC_VERSION,
	},
	...overrides,
});

const makeOps = (existing: ExistingRouterContainer) => {
	const calls: string[] = [];
	const createArgs: Array<Parameters<TraefikContainerOps['createFresh']>[0]> = [];
	const ops: TraefikContainerOps = {
		ensureNetwork: (name) => {
			calls.push(`ensureNetwork:${name}`);
			return Effect.succeed({ id: 'network-id' });
		},
		inspectContainer: (name) => {
			calls.push(`inspect:${name}`);
			return Effect.succeed(existing);
		},
		createFresh: (args) => {
			calls.push(`createFresh:${args.dispatchDirHostPath}`);
			createArgs.push(args);
			return Effect.succeed({ id: 'created-id' });
		},
		resume: (name) => {
			calls.push(`resume:${name}`);
			return Effect.succeed({ id: 'resumed-id' });
		},
		forceRemove: (name) => {
			calls.push(`forceRemove:${name}`);
			return Effect.void;
		},
	};
	return { calls, createArgs, layer: Layer.succeed(TraefikContainerOpsService)(ops) };
};

describe('bootstrap dispatch bind mount adoption', () => {
	it('does not accept app-stack Compose grouping labels on the router singleton', () => {
		expect(
			routerProfileLabelsMatch(
				{
					[LabelKey.managed]: 'true',
					[LabelKey.kind]: ROUTER_KIND_LABEL_VALUE,
					[ROUTER_PROFILE_LABEL]: profile.id,
					[LabelKey.specVersion]: ROUTER_CONTAINER_SPEC_VERSION,
					[ComposeLabelKey.project]: 'example-main',
					[ComposeLabelKey.service]: 'router.traefik',
				},
				profile,
			),
		).toBe(false);
	});

	it('rejects a router singleton from an older container spec version', () => {
		expect(
			routerProfileLabelsMatch(
				{
					[LabelKey.managed]: 'true',
					[LabelKey.kind]: ROUTER_KIND_LABEL_VALUE,
					[ROUTER_PROFILE_LABEL]: profile.id,
				},
				profile,
			),
		).toBe(false);
	});

	it.effect('adopts a running singleton only when the watched dispatch root matches', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [];
			const { calls, layer } = makeOps(matchingExisting(entrypoints));
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report).toEqual({
				decision: 'adopt',
				containerId: 'existing-id',
				networkId: 'network-id',
				imageMatches: true,
			});
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
			]);
		}),
	);

	it('renders one Traefik listener for entrypoint aliases that share a port', () => {
		const entrypoints: ReadonlyArray<Entrypoint> = [
			{ name: 'walrus-node-0', port: 9185, protocol: 'http' },
			{ name: 'walrus-node-1', port: 9185, protocol: 'http' },
			{ name: 'walrus-aggregator', port: 9185, protocol: 'http' },
		];

		const command = traefikExpectedCommand(entrypoints);
		expect(command).toContain('--entrypoints.walrus-node-0.address=:9185');
		expect(command).not.toContain('--entrypoints.walrus-node-1.address=:9185');
		expect(command).not.toContain('--entrypoints.walrus-aggregator.address=:9185');
		expect(traefikExpectedPortBindings(entrypoints)).toEqual(['9185/tcp=127.0.0.1:9185']);
	});

	it.effect('docker-backed boot adopts a matching router when inspect omits top-level Image', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'router-inspect-no-top-image-test-'));
			try {
				const entrypoints: ReadonlyArray<Entrypoint> = [
					{ name: 'wallet-app', port: 6173, protocol: 'http' },
				];
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(matchingRouterNetworkJson())}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(matchingDockerInspectJson(entrypoints))}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ] || [ "$1" = "rm" ] || [ "$1" = "start" ]; then',
					'  echo "unexpected mutation" >&2',
					'  exit 1',
					'fi',
					'exit 1',
					'',
				]);

				const report = yield* bootstrap({
					image: 'traefik:v3.5',
					entrypoints,
					profile,
					protectedRouteLeaseIds: [],
				}).pipe(
					Effect.provide(layerTraefikContainerOpsDocker),
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(report).toEqual({
					decision: 'adopt',
					containerId: 'router-id',
					networkId: 'network-id',
					imageMatches: true,
				});
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toEqual([
					`network inspect ${profile.networkName}`,
					`container inspect ${profile.containerName}`,
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('docker-backed boot creates fresh when only the same-name router network exists', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'router-inspect-network-collision-test-'));
			try {
				const entrypoints: ReadonlyArray<Entrypoint> = [
					{ name: 'wallet-app', port: 6173, protocol: 'http' },
				];
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(matchingRouterNetworkJson())}`,
					'  exit 0',
					'fi',
					'if [ "$CONTAINER_INSPECT" = "1" ]; then',
					`  echo "Error: No such container: ${profile.containerName}" >&2`,
					'  exit 1',
					'fi',
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(matchingRouterNetworkJson())}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ]; then',
					'  printf "router-created-id\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "rm" ] || [ "$1" = "start" ]; then',
					'  echo "unexpected mutation" >&2',
					'  exit 1',
					'fi',
					'exit 1',
					'',
				]);

				const report = yield* bootstrap({
					image: 'traefik:v3.5',
					entrypoints,
					profile,
					protectedRouteLeaseIds: [],
				}).pipe(
					Effect.provide(layerTraefikContainerOpsDocker),
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(report).toEqual({
					decision: 'recreate-fresh',
					containerId: 'router-created-id',
					networkId: 'network-id',
					imageMatches: true,
				});
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines[0]).toBe(`network inspect ${profile.networkName}`);
				expect(lines[1]).toBe(`container inspect ${profile.containerName}`);
				expect(
					lines.some((line) => line.startsWith(`run -d --name ${profile.containerName}`)),
				).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('docker-backed boot adopts a matching router when inspect omits HostConfig', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'router-inspect-no-host-config-test-'));
			try {
				const entrypoints: ReadonlyArray<Entrypoint> = [
					{ name: 'wallet-app', port: 6173, protocol: 'http' },
				];
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(matchingRouterNetworkJson())}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(
						matchingDockerInspectJson(entrypoints, { includeHostConfig: false }),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "run" ] || [ "$1" = "rm" ] || [ "$1" = "start" ]; then',
					'  echo "unexpected mutation" >&2',
					'  exit 1',
					'fi',
					'exit 1',
					'',
				]);

				const report = yield* bootstrap({
					image: 'traefik:v3.5',
					entrypoints,
					profile,
					protectedRouteLeaseIds: [],
				}).pipe(
					Effect.provide(layerTraefikContainerOpsDocker),
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(report).toEqual({
					decision: 'adopt',
					containerId: 'router-id',
					networkId: 'network-id',
					imageMatches: true,
				});
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toEqual([
					`network inspect ${profile.networkName}`,
					`container inspect ${profile.containerName}`,
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('docker-backed boot recreates a matching router when inspect omits State', () =>
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), 'router-inspect-no-state-test-'));
			try {
				const entrypoints: ReadonlyArray<Entrypoint> = [
					{ name: 'wallet-app', port: 6173, protocol: 'http' },
				];
				const { bin, log } = writeDocker(root, [
					'if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(matchingRouterNetworkJson())}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "inspect" ]; then',
					`  printf '%s\\n' ${JSON.stringify(
						matchingDockerInspectJson(entrypoints, {
							includeHostConfig: false,
							includeState: false,
						}),
					)}`,
					'  exit 0',
					'fi',
					'if [ "$1" = "rm" ]; then exit 0; fi',
					'if [ "$1" = "run" ]; then',
					'  printf "router-created-id\\n"',
					'  exit 0',
					'fi',
					'if [ "$1" = "start" ]; then',
					'  echo "unexpected start" >&2',
					'  exit 1',
					'fi',
					'exit 1',
					'',
				]);

				const report = yield* bootstrap({
					image: 'traefik:v3.5',
					entrypoints,
					profile,
					protectedRouteLeaseIds: [],
				}).pipe(
					Effect.provide(layerTraefikContainerOpsDocker),
					Effect.provide(fakeDockerLayer(bin)),
				);

				expect(report).toEqual({
					decision: 'recreate-fresh',
					containerId: 'router-created-id',
					networkId: 'network-id',
					imageMatches: true,
				});
				const lines = readFileSync(log, 'utf8').trim().split('\n');
				expect(lines).toContain(`rm -f ${profile.containerName}`);
				expect(
					lines.some((line) => line.startsWith(`run -d --name ${profile.containerName}`)),
				).toBe(true);
				expect(lines.some((line) => line.startsWith('start '))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	);

	it.effect('recreates a running singleton with a stale stack-scoped dispatch bind mount', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [];
			const { calls, createArgs, layer } = makeOps(
				matchingExisting(entrypoints, {
					dispatchMount: {
						source: '/tmp/app/main/router/dispatch',
						target: TRAEFIK_DISPATCH_MOUNT_TARGET,
						readOnly: true,
					},
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(createArgs[0]?.dispatchDirHostPath).toBe(dispatchDir);
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
				`forceRemove:${profile.containerName}`,
				`createFresh:${dispatchDir}`,
			]);
		}),
	);

	it.effect('refuses to recreate a mismatched singleton while protected route leases exist', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [];
			const { calls, layer } = makeOps(
				matchingExisting(entrypoints, {
					dispatchMount: {
						source: '/tmp/app/main/router/dispatch',
						target: TRAEFIK_DISPATCH_MOUNT_TARGET,
						readOnly: true,
					},
				}),
			);
			const err = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: ['live-route'],
			})
				.pipe(Effect.provide(layer))
				.pipe(Effect.flip);

			expect(err._tag).toBe('RouterBootFailed');
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
			]);
		}),
	);

	it.effect(
		'refuses to reuse a matching singleton with unknown state while protected leases exist',
		() =>
			Effect.gen(function* () {
				const entrypoints: ReadonlyArray<Entrypoint> = [];
				const { calls, layer } = makeOps(
					matchingExisting(entrypoints, {
						running: 'unknown',
					}),
				);
				const err = yield* bootstrap({
					image: 'traefik:v3.5',
					entrypoints,
					profile,
					protectedRouteLeaseIds: ['live-route'],
				})
					.pipe(Effect.provide(layer))
					.pipe(Effect.flip);

				expect(err._tag).toBe('RouterBootFailed');
				expect(calls).toEqual([
					`ensureNetwork:${profile.networkName}`,
					`inspect:${profile.containerName}`,
				]);
			}),
	);

	it.effect('recreates an existing singleton when the dispatch bind mount is missing', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [];
			const { calls, layer } = makeOps(
				matchingExisting(entrypoints, {
					running: false,
					dispatchMount: null,
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(calls).toContain(`forceRemove:${profile.containerName}`);
			expect(calls).toContain(`createFresh:${dispatchDir}`);
		}),
	);

	it.effect('recreates a running singleton when entrypoint command args are stale', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [
				{ name: 'wallet-app', port: 6173, protocol: 'http' },
				{ name: 'seal-key-server', port: 2024, protocol: 'http' },
			];
			const { calls, createArgs, layer } = makeOps(
				matchingExisting(entrypoints, {
					command: traefikExpectedCommand(entrypoints).filter(
						(arg) => arg !== '--entrypoints.seal-key-server.address=:2024',
					),
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(createArgs[0]?.entrypoints).toEqual(entrypoints);
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
				`forceRemove:${profile.containerName}`,
				`createFresh:${dispatchDir}`,
			]);
		}),
	);

	it.effect('recreates a running singleton when published entrypoint ports are stale', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [
				{ name: 'wallet-app', port: 6173, protocol: 'http' },
				{ name: 'seal-key-server', port: 2024, protocol: 'http' },
			];
			const { calls, layer } = makeOps(
				matchingExisting(entrypoints, {
					portBindings: ['6173/tcp=0.0.0.0:6173'],
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(calls).toContain(`forceRemove:${profile.containerName}`);
		}),
	);

	it.effect('adopts when Docker reports duplicate host-IP bindings for the same ports', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [
				{ name: 'wallet-app', port: 6173, protocol: 'http' },
			];
			const { calls, layer } = makeOps(
				matchingExisting(entrypoints, {
					portBindings: [...traefikExpectedPortBindings(entrypoints), '6173/tcp=127.0.0.1:6173'],
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('adopt');
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
			]);
		}),
	);

	it.effect('recreates a running singleton when the dispatch mount is writable', () =>
		Effect.gen(function* () {
			const entrypoints: ReadonlyArray<Entrypoint> = [];
			const { calls, layer } = makeOps(
				matchingExisting(entrypoints, {
					dispatchMount: {
						source: dispatchDir,
						target: TRAEFIK_DISPATCH_MOUNT_TARGET,
						readOnly: false,
					},
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(calls).toContain(`forceRemove:${profile.containerName}`);
		}),
	);
});

// Router coexistence: a live SHARED router that publishes a SUPERSET of
// the entrypoints this stack needs (another build's extra `:9810`
// listener) must be adoptable — extra entrypoints can't mis-route
// Host-header dispatch. A router MISSING a required entrypoint (subset),
// or one carrying a different image / spec-version, must STILL be a
// mismatch so the live-route fail-safe (RouterBootFailed) stays intact.
describe('routerSpecMatches superset-entrypoint coexistence', () => {
	const required: ReadonlyArray<Entrypoint> = [
		{ name: 'wallet-app', port: 6173, protocol: 'http' },
	];
	// Same required listener PLUS an extra one from a co-resident build.
	const superset: ReadonlyArray<Entrypoint> = [
		{ name: 'wallet-app', port: 6173, protocol: 'http' },
		{ name: 'other-build', port: 9810, protocol: 'http' },
	];

	it.effect('adopts a shared router with a SUPERSET of the required entrypoints', () =>
		Effect.gen(function* () {
			// Existing router is built against the wider `superset` set, so
			// its published port bindings + Traefik command args carry the
			// extra `:9810` listener on top of everything this stack needs.
			const { calls, layer } = makeOps(matchingExisting(superset));
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints: required,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('adopt');
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
			]);
		}),
	);

	it.effect('adopts a SUPERSET router even while protected route leases are live', () =>
		Effect.gen(function* () {
			// The exact regression: superset router + live routes must NOT
			// trip the RouterBootFailed fail-safe — it must adopt.
			const { calls, layer } = makeOps(matchingExisting(superset));
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints: required,
				profile,
				protectedRouteLeaseIds: ['live-route'],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('adopt');
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
			]);
		}),
	);

	it.effect('does NOT adopt a router MISSING a required entrypoint (subset)', () =>
		Effect.gen(function* () {
			// Existing router only published the `:9810` listener; it is
			// missing the `:6173` entrypoint this stack requires. A subset is
			// a genuine mismatch → recreate fresh.
			const subset: ReadonlyArray<Entrypoint> = [
				{ name: 'other-build', port: 9810, protocol: 'http' },
			];
			const { calls, layer } = makeOps(matchingExisting(subset));
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints: required,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(calls).toContain(`forceRemove:${profile.containerName}`);
		}),
	);

	it.effect('fails safe on a subset router when protected route leases are live', () =>
		Effect.gen(function* () {
			// Subset (missing required entrypoint) + live routes → the
			// fail-safe must still fire; we must not destroy live routing.
			const subset: ReadonlyArray<Entrypoint> = [
				{ name: 'other-build', port: 9810, protocol: 'http' },
			];
			const { calls, layer } = makeOps(matchingExisting(subset));
			const err = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints: required,
				profile,
				protectedRouteLeaseIds: ['live-route'],
			})
				.pipe(Effect.provide(layer))
				.pipe(Effect.flip);

			expect(err._tag).toBe('RouterBootFailed');
			expect(calls).toEqual([
				`ensureNetwork:${profile.networkName}`,
				`inspect:${profile.containerName}`,
			]);
		}),
	);

	it.effect('does NOT adopt a SUPERSET router running a DIFFERENT image', () =>
		Effect.gen(function* () {
			// Superset entrypoints, but a different image tag — a profile
			// singleton cannot reconcile image in place. Still a mismatch.
			const { calls, layer } = makeOps(matchingExisting(superset, { image: 'traefik:v3.4' }));
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints: required,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(calls).toContain(`forceRemove:${profile.containerName}`);
		}),
	);

	it.effect('does NOT adopt a SUPERSET router from a DIFFERENT spec version', () =>
		Effect.gen(function* () {
			// Superset entrypoints, but an older container spec-version label.
			// Spec-version stays an exact-match dimension → mismatch.
			const { calls, layer } = makeOps(
				matchingExisting(superset, {
					labels: {
						[LabelKey.managed]: 'true',
						[LabelKey.kind]: ROUTER_KIND_LABEL_VALUE,
						[ROUTER_PROFILE_LABEL]: profile.id,
						[LabelKey.specVersion]: 'spec-version-from-an-older-build',
					},
				}),
			);
			const report = yield* bootstrap({
				image: 'traefik:v3.5',
				entrypoints: required,
				profile,
				protectedRouteLeaseIds: [],
			}).pipe(Effect.provide(layer));

			expect(report.decision).toBe('recreate-fresh');
			expect(calls).toContain(`forceRemove:${profile.containerName}`);
		}),
	);
});
