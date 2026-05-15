import { Effect, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { tag, setPhase, type Ref } from '../advanced/tag.js';
import * as Docker from '../engine/docker.js';
import {
	awaitReady,
	type InternalReadyProbe,
	type ReadyProbe,
} from '../engine/ready-probe.js';
import { EndpointRegistry } from '../engine/registries.js';
import { DockerError } from './errors.js';

export interface DockerContainerHandle {
	readonly containerId: string;
	readonly url: string | undefined;
}

export interface DockerContainerOptions<Name extends string, E, R> {
	readonly name: Name;
	readonly image: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Record<string, string> | Effect.Effect<Record<string, string>, E, R>;
	readonly ports?: Readonly<Record<number, number>>;
	readonly mounts?: ReadonlyArray<{ readonly host: string; readonly container: string }>;
	readonly network?: string;
	/** Container hostname (`--hostname`). Sets the value `hostname`
	 *  returns inside the container; useful when the workload self-
	 *  identifies via its hostname. */
	readonly hostname?: string;
	/** Static IP within `network` (`--ip`). Requires `network` to be set. */
	readonly ip?: string;
	/** Additional DNS alias for the container on `network`
	 *  (`--network-alias`). Requires `network` to be set. */
	readonly networkAlias?: string;
	readonly readyProbe?: ReadyProbe;
	readonly dependsOn?: ReadonlyArray<Ref<any, any, any, any>>;
	readonly endpoint?: { readonly name: string; readonly kind?: string };
}

export const dockerContainer = <const Name extends string, E = never, R = never>(
	options: DockerContainerOptions<Name, E, R>,
) =>
	tag(
		options.name,
		Effect.gen(function* () {
			// 1. Resolve env: literal record, Effect, or undefined.
			const envOpt = options.env;
			const resolvedEnv: Record<string, string> =
				envOpt === undefined ? {} : Effect.isEffect(envOpt) ? yield* envOpt : envOpt;

			// 2. Resolve dependsOn — yield* each tag for ordering.
			for (const tag of options.dependsOn ?? []) {
				yield* tag;
			}

			yield* Effect.annotateCurrentSpan({
				'dockerContainer.name': options.name,
				'dockerContainer.image': options.image,
			});

			yield* setPhase('starting container');
			// 3. Start the container. Docker.run installs its own Scope
			//    finalizer (docker rm -f) so cleanup is automatic.
			const { containerId } = yield* Docker.run({
				name: options.name,
				image: options.image,
				args: options.args,
				env: resolvedEnv,
				ports: options.ports as Record<number, number> | undefined,
				mounts: options.mounts,
				network: options.network,
				hostname: options.hostname,
				ip: options.ip,
				networkAlias: options.networkAlias,
			}).pipe(
				Effect.catchTag('DockerError', (cause) =>
					Effect.fail(
						new DockerError({
							op: 'dockerContainer',
							message: `dockerContainer '${options.name}': ${cause.message}`,
							cause,
						}),
					),
				),
			);
			yield* Effect.annotateCurrentSpan({ 'dockerContainer.containerId': containerId });

			// 4. Wait for the ready probe if provided. Log probes shell out
			//    to `docker logs -f` for their stream because `Docker.run`
			//    is detached and doesn't return one directly. We resolve
			//    the spawner here and provide it to the stream so the
			//    `ReadyProbe.logs` field stays `R = never`.
			if (options.readyProbe !== undefined) {
				yield* setPhase('awaiting ready');
				let probe: InternalReadyProbe;
				if (options.readyProbe.kind === 'log') {
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
					const logs = Docker.followLogs(containerId).pipe(
						Stream.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
					);
					probe = { ...options.readyProbe, logs };
				} else {
					probe = options.readyProbe;
				}
				yield* awaitReady(probe).pipe(
					Effect.catchTag('ReadyProbeError', (cause) =>
						Effect.fail(
							new DockerError({
								op: 'dockerContainer',
								message: `dockerContainer '${options.name}': ready probe failed: ${cause.message}`,
								cause,
							}),
						),
					),
				);
			}

			// 5. Register endpoint. Prefer the HTTP probe URL when present;
			//    fall back to a synthesized localhost URL using the first
			//    declared port mapping.
			const url =
				options.readyProbe?.kind === 'http'
					? options.readyProbe.url
					: firstHostPort(options.ports) !== undefined
						? `http://localhost:${firstHostPort(options.ports)!}`
						: undefined;
			if (options.endpoint !== undefined && url !== undefined) {
				yield* EndpointRegistry.publish({
					name: options.endpoint.name,
					url,
					kind: options.endpoint.kind,
				});
			}

			return { containerId, url } satisfies DockerContainerHandle;
		}).pipe(Effect.withSpan(`dockerContainer(${options.name})`)),
		{
			kind: 'service',
			displayTitle: options.name,
			display: (s) => ({
				title: options.name,
				primary: s.url ?? `container ${s.containerId.slice(0, 12)}`,
			}),
		},
	);

// Pick the first host-side port number from the user's `ports` map. Used to
// guess a URL when the user didn't give us an HTTP ready probe but still
// wants the endpoint published. Returns undefined if no ports are mapped.
const firstHostPort = (ports: Readonly<Record<number, number>> | undefined): number | undefined => {
	if (ports === undefined) return undefined;
	const first = Object.keys(ports)[0];
	if (first === undefined) return undefined;
	const n = Number(first);
	return Number.isFinite(n) ? n : undefined;
};
