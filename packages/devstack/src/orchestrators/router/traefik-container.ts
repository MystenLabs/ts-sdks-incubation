// Traefik container lifecycle — router-profile singleton.
//
// Architecture distilled-doc §"Lifecycle states":
//   | Found state                | Image matches | Action                       |
//   |----------------------------|---------------|------------------------------|
//   | Container absent           | n/a           | Ensure network + create fresh|
//   | Container running          | yes           | Adopt (no-op)                |
//   | Container running          | no            | Force-remove + create fresh  |
//   | Container stopped          | yes           | Resume; on fail recreate fresh|
//   | Container stopped          | no            | Force-remove + create fresh  |
//   | Network absent             | n/a           | Create network first         |
//
// Key invariants:
//   - One container per router profile. NOT per-stack — the router
//     outlives any one `pnpm dev`.
//   - The container does NOT take the stack identity label set;
//     instead a singleton router label distinguishes it from per-stack
//     resources (so per-stack `wipe` doesn't touch it).
//   - Bootstrap runs ONCE per supervisor lifetime (architecture
//     invariant #11). Hot-reload cycles do NOT re-pay docker inspect.
//
// This file is INTENTIONALLY a thin orchestration shell. Real container
// I/O lives in `runtime/docker/*`; the effectful operations are
// abstracted behind a `TraefikContainerOps` service so tests can inject
// a no-op implementation without changing route delivery.

import { Context, Effect, Layer } from 'effect';
import * as path from 'node:path';

import { RouterBootFailed } from './errors.ts';
import type { Entrypoint } from './entrypoints.ts';
import {
	DockerHost,
	DockerSpawner,
	ComposeLabelKey,
	ensureNetwork,
	inspectContainer,
	isNoSuchContainerStderr,
	LabelKey,
} from '../../runtime/docker/index.ts';
import { dockerRun, dockerRunOk } from '../../runtime/docker/client.ts';
import type { RouterProfile } from './profile.ts';

export const TRAEFIK_DISPATCH_MOUNT_TARGET = '/etc/traefik/dispatch';
export const ROUTER_PROFILE_LABEL = 'devstack.router.profile';
export const HOST_GATEWAY_ALIAS = 'host.docker.internal:host-gateway';

/** Default Traefik image. Tag, not digest — distilled-doc open
 *  question #9 (digest-pin is a follow-up). */
export const DEFAULT_TRAEFIK_IMAGE = 'traefik:v3.5';

// ---------------------------------------------------------------------------
// BootDecision — observability shape
// ---------------------------------------------------------------------------

/** What the lifecycle decision was. Emitted as a span attribute and
 *  threaded into the inventory row (architecture distilled-doc
 *  §"Outputs / capabilities provided" — "A boot-decision report"). */
export type BootDecision = 'adopt' | 'resume' | 'recreate-fresh' | 'opt-out';

export interface BootReport {
	readonly decision: BootDecision;
	readonly containerId: string | null;
	readonly networkId: string | null;
	/** Whether the observed or freshly-created container is the right image. */
	readonly imageMatches: boolean;
}

// ---------------------------------------------------------------------------
// TraefikContainerOps — the I/O seam
// ---------------------------------------------------------------------------

export interface InspectedTraefikContainer {
	readonly id: string;
	readonly running: boolean | 'unknown';
	readonly image: string;
	readonly dispatchMount: {
		readonly source: string;
		readonly target: string;
		readonly readOnly: boolean;
	} | null;
	readonly portBindings: ReadonlyArray<string>;
	readonly command: ReadonlyArray<string>;
	readonly networks: ReadonlyArray<string>;
	readonly labels: Readonly<Record<string, string>>;
}

/** The orchestrator does NOT talk to docker directly. It yields these
 *  operations through a service tag whose layer can be wired to
 *  `runtime/docker/*` in production or to a no-op stub in tests. This
 *  is the load-bearing decoupling that lets the orchestrator stay at
 *  "walk decls + write files" complexity without growing a docker
 *  dependency.
 *
 *  Architecture: orchestrator depends on L0+L1 contracts, never on
 *  concrete L1 implementations. */
export interface TraefikContainerOps {
	/** Idempotent network ensure. Returns the network id. */
	readonly ensureNetwork: (
		name: string,
	) => Effect.Effect<{ readonly id: string }, RouterBootFailed>;

	/** Inspect the singleton router container. Returns `null` when
	 *  absent. */
	readonly inspectContainer: (
		name: string,
	) => Effect.Effect<InspectedTraefikContainer | null, RouterBootFailed>;

	/** Create the container fresh (after force-remove if necessary).
	 *  The container is started with file-provider configured against
	 *  `dispatchDirHostPath` (bind-mounted read-only to `/etc/traefik/dispatch`)
	 *  and one `--entrypoints.<name>.address=:<port>` flag per registered
	 *  entrypoint. The shared network is attached at create time. */
	readonly createFresh: (args: {
		readonly name: string;
		readonly image: string;
		readonly network: string;
		readonly routerProfileId: string;
		readonly entrypoints: ReadonlyArray<Entrypoint>;
		readonly dispatchDirHostPath: string;
	}) => Effect.Effect<{ readonly id: string }, RouterBootFailed>;

	/** Start an already-existing stopped container. May fail (port
	 *  conflict, daemon flake); caller's contract is to fall back to
	 *  fresh-recreate on failure. */
	readonly resume: (name: string) => Effect.Effect<{ readonly id: string }, RouterBootFailed>;

	/** Force-remove a container (running or stopped). Idempotent on
	 *  "no such container". */
	readonly forceRemove: (name: string) => Effect.Effect<void, RouterBootFailed>;
}

export class TraefikContainerOpsService extends Context.Service<
	TraefikContainerOpsService,
	TraefikContainerOps
>()('@devstack-rewrite/orchestrators/router/TraefikContainerOps') {}

// ---------------------------------------------------------------------------
// Bootstrap — decides + executes
// ---------------------------------------------------------------------------

export interface BootstrapInputs {
	readonly image: string;
	readonly entrypoints: ReadonlyArray<Entrypoint>;
	readonly profile: RouterProfile;
	readonly protectedRouteLeaseIds: ReadonlyArray<string>;
}

const sameHostPath = (left: string, right: string): boolean =>
	path.resolve(left) === path.resolve(right);

export const uniqueSortedEntrypointPorts = (
	entrypoints: ReadonlyArray<Entrypoint>,
): ReadonlyArray<number> =>
	[...new Set(entrypoints.map((entrypoint) => entrypoint.port))].sort((a, b) => a - b);

export const traefikExpectedPortBindings = (
	entrypoints: ReadonlyArray<Entrypoint>,
): ReadonlyArray<string> =>
	uniqueSortedEntrypointPorts(entrypoints).map((port) => `${port}/tcp=127.0.0.1:${port}`);

const traefikExpectedPortPairs = (entrypoints: ReadonlyArray<Entrypoint>): ReadonlyArray<string> =>
	uniqueSortedEntrypointPorts(entrypoints).map((port) => `${port}=127.0.0.1:${port}`);

export const traefikExpectedCommand = (
	entrypoints: ReadonlyArray<Entrypoint>,
): ReadonlyArray<string> => [
	`--providers.file.directory=${TRAEFIK_DISPATCH_MOUNT_TARGET}`,
	'--providers.file.watch=true',
	'--api.dashboard=false',
	'--log.level=INFO',
	...entrypoints.map(
		(entrypoint) => `--entrypoints.${entrypoint.name}.address=:${entrypoint.port}`,
	),
];

const mountedDispatchDirMatches = (
	existing: {
		readonly dispatchMount: {
			readonly source: string;
			readonly target: string;
			readonly readOnly: boolean;
		} | null;
	},
	expected: string,
): boolean =>
	existing.dispatchMount !== null &&
	existing.dispatchMount.target === TRAEFIK_DISPATCH_MOUNT_TARGET &&
	existing.dispatchMount.readOnly &&
	sameHostPath(existing.dispatchMount.source, expected);

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const sameStringSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	sameStrings([...new Set(left)].sort(), [...new Set(right)].sort());

const portBindingPair = (binding: string): string | null => {
	const [container, host] = binding.split('=');
	const containerPort = container?.split('/')[0];
	const hostPort = host?.slice(host.lastIndexOf(':') + 1);
	const hostIp = host?.slice(0, host.lastIndexOf(':'));
	if (containerPort === undefined || hostPort === undefined || hostIp === undefined) return null;
	if (!/^\d+$/.test(containerPort) || !/^\d+$/.test(hostPort)) return null;
	return `${containerPort}=${hostIp}:${hostPort}`;
};

const portBindingsMatch = (
	existing: ReadonlyArray<string>,
	entrypoints: ReadonlyArray<Entrypoint>,
): boolean =>
	sameStringSet(
		existing.flatMap((binding) => {
			const pair = portBindingPair(binding);
			return pair === null ? [] : [pair];
		}),
		traefikExpectedPortPairs(entrypoints),
	);

export const routerProfileLabelsMatch = (
	labels: Readonly<Record<string, string>>,
	profile: RouterProfile,
): boolean => {
	if (labels[LabelKey.managed] !== 'true') return false;
	if (labels[LabelKey.routerMarker] !== 'true') return false;
	if (labels[ROUTER_PROFILE_LABEL] !== profile.id) return false;
	for (const forbidden of [
		LabelKey.app,
		LabelKey.stack,
		LabelKey.plugin,
		LabelKey.role,
		LabelKey.cycle,
		ComposeLabelKey.project,
		ComposeLabelKey.service,
		ComposeLabelKey.containerNumber,
		ComposeLabelKey.version,
		ComposeLabelKey.oneoff,
		ComposeLabelKey.network,
		ComposeLabelKey.volume,
	]) {
		if (labels[forbidden] !== undefined) return false;
	}
	return true;
};

const routerSpecMatches = (existing: InspectedTraefikContainer, inputs: BootstrapInputs): boolean =>
	existing.image === inputs.image &&
	mountedDispatchDirMatches(existing, inputs.profile.dispatchDir) &&
	portBindingsMatch(existing.portBindings, inputs.entrypoints) &&
	sameStringSet(existing.command, traefikExpectedCommand(inputs.entrypoints)) &&
	existing.networks.includes(inputs.profile.networkName) &&
	routerProfileLabelsMatch(existing.labels, inputs.profile);

/** Adopt-or-create per the architecture's 4-way decision table.
 *  Idempotent: callers may invoke this once per supervisor lifetime,
 *  and a follow-up call returns `decision: 'adopt'` if nothing has
 *  changed. */
export const bootstrap = (
	inputs: BootstrapInputs,
): Effect.Effect<BootReport, RouterBootFailed, TraefikContainerOpsService> =>
	Effect.gen(function* () {
		const ops = yield* TraefikContainerOpsService;
		const network = yield* ops.ensureNetwork(inputs.profile.networkName);
		const existing = yield* ops.inspectContainer(inputs.profile.containerName);

		// Decision table.
		if (existing === null) {
			const created = yield* ops.createFresh({
				name: inputs.profile.containerName,
				image: inputs.image,
				network: inputs.profile.networkName,
				routerProfileId: inputs.profile.id,
				entrypoints: inputs.entrypoints,
				dispatchDirHostPath: inputs.profile.dispatchDir,
			});
			return {
				decision: 'recreate-fresh' as const,
				containerId: created.id,
				networkId: network.id,
				imageMatches: true,
			};
		}

		const configMatches = routerSpecMatches(existing, inputs);

		if (existing.running === true && configMatches) {
			return {
				decision: 'adopt' as const,
				containerId: existing.id,
				networkId: network.id,
				imageMatches: true,
			};
		}

		if (existing.running === 'unknown' && configMatches) {
			if (inputs.protectedRouteLeaseIds.length > 0) {
				return yield* Effect.fail(
					new RouterBootFailed({
						stage: 'ensure-container',
						detail:
							`router profile '${inputs.profile.id}' container '${inputs.profile.containerName}' ` +
							`has unknown lifecycle state, and live or unknown route leases exist: ` +
							inputs.protectedRouteLeaseIds.join(', '),
					}),
				);
			}
			yield* ops.forceRemove(inputs.profile.containerName);
			const created = yield* ops.createFresh({
				name: inputs.profile.containerName,
				image: inputs.image,
				network: inputs.profile.networkName,
				routerProfileId: inputs.profile.id,
				entrypoints: inputs.entrypoints,
				dispatchDirHostPath: inputs.profile.dispatchDir,
			});
			return {
				decision: 'recreate-fresh' as const,
				containerId: created.id,
				networkId: network.id,
				imageMatches: true,
			};
		}

		if (!configMatches) {
			if (inputs.protectedRouteLeaseIds.length > 0) {
				return yield* Effect.fail(
					new RouterBootFailed({
						stage: 'ensure-container',
						detail:
							`router profile '${inputs.profile.id}' container '${inputs.profile.containerName}' ` +
							`does not match the requested spec, but live or unknown route leases exist: ` +
							inputs.protectedRouteLeaseIds.join(', '),
					}),
				);
			}
			// Running or stopped with stale image, bind mount, entrypoints,
			// provider args, network, labels, or mount mode — force-remove
			// + recreate. A profile singleton can only serve the spec it
			// was created with.
			yield* ops.forceRemove(inputs.profile.containerName);
			const created = yield* ops.createFresh({
				name: inputs.profile.containerName,
				image: inputs.image,
				network: inputs.profile.networkName,
				routerProfileId: inputs.profile.id,
				entrypoints: inputs.entrypoints,
				dispatchDirHostPath: inputs.profile.dispatchDir,
			});
			return {
				decision: 'recreate-fresh' as const,
				containerId: created.id,
				networkId: network.id,
				imageMatches: true,
			};
		}

		// Stopped + image matches → resume; on failure recreate fresh.
		const resumed = yield* ops.resume(inputs.profile.containerName).pipe(
			Effect.catchTag('RouterBootFailed', (cause) =>
				inputs.protectedRouteLeaseIds.length > 0
					? Effect.fail(
							new RouterBootFailed({
								stage: 'ensure-container',
								detail:
									`router profile '${inputs.profile.id}' container '${inputs.profile.containerName}' ` +
									`could not be resumed, and live or unknown route leases exist: ` +
									inputs.protectedRouteLeaseIds.join(', '),
								cause,
							}),
						)
					: ops.forceRemove(inputs.profile.containerName).pipe(
							Effect.andThen(
								ops.createFresh({
									name: inputs.profile.containerName,
									image: inputs.image,
									network: inputs.profile.networkName,
									routerProfileId: inputs.profile.id,
									entrypoints: inputs.entrypoints,
									dispatchDirHostPath: inputs.profile.dispatchDir,
								}),
							),
						),
			),
		);
		return {
			decision: 'resume' as const,
			containerId: resumed.id,
			networkId: network.id,
			imageMatches: true,
		};
	}).pipe(Effect.withSpan('orchestrator.router.bootstrap'));

// ---------------------------------------------------------------------------
// Docker-backed layer
// ---------------------------------------------------------------------------

const routerBootFailed = (
	stage: RouterBootFailed['stage'],
	detail: string,
	cause?: unknown,
): RouterBootFailed =>
	new RouterBootFailed({
		stage,
		detail,
		...(cause === undefined ? {} : { cause }),
	});

const traefikRunArgs = (args: {
	readonly name: string;
	readonly image: string;
	readonly network: string;
	readonly routerProfileId: string;
	readonly entrypoints: ReadonlyArray<Entrypoint>;
	readonly dispatchDirHostPath: string;
}): ReadonlyArray<string> => {
	const ports = uniqueSortedEntrypointPorts(args.entrypoints);
	const dockerArgs: Array<string> = [
		'-d',
		'--name',
		args.name,
		'--network',
		args.network,
		'--label',
		`${LabelKey.managed}=true`,
		'--label',
		`${LabelKey.routerMarker}=true`,
		'--label',
		`${ROUTER_PROFILE_LABEL}=${args.routerProfileId}`,
		'--add-host',
		HOST_GATEWAY_ALIAS,
	];
	for (const port of ports) {
		dockerArgs.push('-p', `127.0.0.1:${port}:${port}`);
	}
	dockerArgs.push(
		'--mount',
		`type=bind,source=${args.dispatchDirHostPath},target=${TRAEFIK_DISPATCH_MOUNT_TARGET},readonly`,
		args.image,
		...traefikExpectedCommand(args.entrypoints),
	);
	return dockerArgs;
};

export const layerTraefikContainerOpsDocker: Layer.Layer<
	TraefikContainerOpsService,
	never,
	DockerHost | DockerSpawner
> = Layer.effect(
	TraefikContainerOpsService,
	Effect.gen(function* () {
		const dockerHost = yield* DockerHost;
		const dockerSpawner = yield* DockerSpawner;
		const provideDocker = <A, E>(
			effect: Effect.Effect<A, E, DockerHost | DockerSpawner>,
		): Effect.Effect<A, E, never> =>
			effect.pipe(
				Effect.provideService(DockerHost, dockerHost),
				Effect.provideService(DockerSpawner, dockerSpawner),
			);

		const ops: TraefikContainerOps = {
			ensureNetwork: (name) =>
				provideDocker(
					ensureNetwork(name, { app: 'devstack-router', stack: name, composeUi: false }),
				).pipe(
					Effect.map((id) => ({ id })),
					Effect.mapError((cause) =>
						routerBootFailed(
							'ensure-network',
							`failed to ensure shared router network '${name}'`,
							cause,
						),
					),
				),
			inspectContainer: (name) =>
				provideDocker(inspectContainer(name)).pipe(
					Effect.mapError((cause) =>
						routerBootFailed('inspect', `failed to inspect router container '${name}'`, cause),
					),
					Effect.map((facts) =>
						facts === null
							? null
							: {
									id: facts.id,
									running: facts.lifecycle.kind === 'unknown' ? 'unknown' : facts.running,
									image: facts.image,
									dispatchMount: (() => {
										const mount = facts.mounts?.find(
											(m) => m.target === TRAEFIK_DISPATCH_MOUNT_TARGET,
										);
										return mount === undefined
											? null
											: {
													source: mount.source,
													target: mount.target,
													readOnly: mount.readOnly === true,
												};
									})(),
									portBindings: facts.portBindings ?? [],
									command: facts.command ?? [],
									networks: facts.networks ?? [],
									labels: facts.labels ?? {},
								},
					),
				),
			createFresh: (args) =>
				provideDocker(dockerRun('run', traefikRunArgs(args))).pipe(
					Effect.map((result) => ({ id: result.stdout.trim() })),
					Effect.mapError((cause) =>
						routerBootFailed(
							'ensure-container',
							`failed to create router container '${args.name}'`,
							cause,
						),
					),
				),
			resume: (name) =>
				provideDocker(dockerRun('start', [name])).pipe(
					Effect.flatMap(() => provideDocker(inspectContainer(name))),
					Effect.flatMap((facts) =>
						facts === null
							? Effect.fail(
									routerBootFailed(
										'inspect',
										`router container '${name}' started but could not be inspected`,
									),
								)
							: Effect.succeed({ id: facts.id }),
					),
					Effect.mapError((cause) =>
						cause instanceof RouterBootFailed
							? cause
							: routerBootFailed(
									'ensure-container',
									`failed to resume router container '${name}'`,
									cause,
								),
					),
				),
			forceRemove: (name) =>
				provideDocker(dockerRunOk('rm', ['-f', name])).pipe(
					Effect.flatMap((result) => {
						if (result.exitCode === 0 || isNoSuchContainerStderr(result.stderr)) {
							return Effect.void;
						}
						return Effect.fail(
							routerBootFailed(
								'ensure-container',
								`failed to remove router container '${name}': ${result.stderr}`,
							),
						);
					}),
					Effect.mapError((cause) =>
						cause instanceof RouterBootFailed
							? cause
							: routerBootFailed(
									'ensure-container',
									`failed to remove router container '${name}'`,
									cause,
								),
					),
				),
		};

		return TraefikContainerOpsService.of(ops);
	}),
);

// ---------------------------------------------------------------------------
// Stub layer — injected by tests
// ---------------------------------------------------------------------------

/** No-op implementation for tests that assert file-provider delivery
 *  without managing a real Traefik container. Production composition
 *  uses `layerTraefikContainerOpsDocker`. */
export const layerTraefikContainerOpsStub: Layer.Layer<TraefikContainerOpsService> = Layer.succeed(
	TraefikContainerOpsService,
)({
	ensureNetwork: (_name) => Effect.succeed({ id: 'stub-network' }),
	inspectContainer: (_name) => Effect.succeed(null),
	createFresh: (_args) => Effect.succeed({ id: 'stub-container' }),
	resume: (_name) => Effect.succeed({ id: 'stub-container' }),
	forceRemove: (_name) => Effect.succeed(undefined),
});
