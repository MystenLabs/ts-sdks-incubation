import { Effect, Layer } from 'effect';
import { describe, expect, it } from '@effect/vitest';

import {
	ROUTER_PROFILE_LABEL,
	TRAEFIK_DISPATCH_MOUNT_TARGET,
	routerProfileLabelsMatch,
	traefikExpectedCommand,
	traefikExpectedPortBindings,
	TraefikContainerOpsService,
	bootstrap,
	type InspectedTraefikContainer,
	type TraefikContainerOps,
} from '../../../src/orchestrators/router/traefik-container.ts';
import { ComposeLabelKey, LabelKey } from '../../../src/runtime/docker/index.ts';
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
		[LabelKey.routerMarker]: 'true',
		[ROUTER_PROFILE_LABEL]: profile.id,
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
					[LabelKey.routerMarker]: 'true',
					[ROUTER_PROFILE_LABEL]: profile.id,
					[ComposeLabelKey.project]: 'example-main',
					[ComposeLabelKey.service]: 'router.traefik',
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
