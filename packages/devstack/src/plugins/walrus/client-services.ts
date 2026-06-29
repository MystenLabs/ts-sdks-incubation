// Walrus local client-service lifecycle.
//
// These are the release-provided `walrus aggregator` and `walrus publisher`
// subcommands, wrapped only enough to feed them the local deploy outputs and
// make them routable through devstack.

import { Effect, Scope } from 'effect';

import type {
	ContainerHandle,
	ContainerRuntime,
	ImageRef,
} from '../../contracts/container-runtime.ts';
import { HOST_GATEWAY_EXTRA_HOSTS } from '../../substrate/runtime/host-gateway.ts';
import { ensureManagedContainer } from '../../substrate/runtime/managed-container.ts';
import {
	ProbeTimeoutError,
	exitCodeProbeResult,
	waitForProbe,
} from '../../substrate/runtime/probes.ts';
import { setCurrentPluginPhase } from '../../substrate/runtime/current-plugin.ts';
import { walrusDeployMountPaths } from './deploy-paths.ts';
import { walrusPluginError, type WalrusPluginError } from './errors.ts';

export const DEFAULT_WALRUS_CLIENT_SERVICE_PORT = 31_415;
export const DEFAULT_WALRUS_CLIENT_SERVICE_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_WALRUS_CLIENT_SERVICE_STOP_GRACE_SECONDS = 10;

export type WalrusClientServiceRole = 'aggregator' | 'publisher';

export interface WalrusClientServiceOptions {
	readonly port: number;
}

export interface WalrusClientService {
	readonly role: WalrusClientServiceRole;
	readonly containerName: string;
	readonly containerPort: number;
}

export interface WalrusClientServices {
	readonly aggregator: WalrusClientService | null;
	readonly publisher: WalrusClientService | null;
}

export interface StartWalrusClientServicesSpec {
	readonly app: string;
	readonly stack: string;
	readonly walrusName: string;
	readonly images: {
		readonly aggregator: ImageRef | null;
		readonly publisher: ImageRef | null;
	};
	readonly options: {
		readonly aggregator: WalrusClientServiceOptions | null;
		readonly publisher: WalrusClientServiceOptions | null;
	};
	readonly walrusNetworkName: string;
	readonly suiNetworkName: string;
	readonly deployHostMountPath: string;
	readonly stackRoot: string;
	readonly deployConfigHash: string;
	readonly suiRpcUrlInNetwork: string;
	readonly stopGraceSeconds?: number;
	readonly readyTimeoutMs?: number;
}

export const walrusClientServiceContainerName = (parts: {
	readonly app: string;
	readonly stack: string;
	readonly walrusName: string;
	readonly role: WalrusClientServiceRole;
}): string => `devstack-${parts.app}-${parts.stack}-walrus-${parts.walrusName}-${parts.role}`;

export const walrusClientServiceConfigHash = (parts: {
	readonly role: WalrusClientServiceRole;
	readonly deployConfigHash: string;
	readonly deploySourceHostPath: string;
	readonly deployMountTarget: string;
	readonly containerPort: number;
	readonly walrusNetworkName: string;
	readonly suiNetworkName: string;
	readonly suiRpcUrlInNetwork: string;
}): string =>
	[
		'walrus-client-service-v1',
		`role=${parts.role}`,
		parts.deployConfigHash,
		`mount=${parts.deploySourceHostPath}->${parts.deployMountTarget}`,
		`port=${parts.containerPort}`,
		`net=${parts.walrusNetworkName},${parts.suiNetworkName}`,
		`rpc=${parts.suiRpcUrlInNetwork}`,
	].join('|');

const SERVICE_READY_PROBE_INTERVAL_MS = 500;
const WALRUS_CLIENT_WALLET_NODE = 'dryrun-node-0';

export const startWalrusClientServices = (
	runtime: ContainerRuntime,
	spec: StartWalrusClientServicesSpec,
): Effect.Effect<WalrusClientServices, WalrusPluginError, Scope.Scope> =>
	Effect.gen(function* () {
		const outerScope = yield* Effect.scope;
		const serviceStopScope = yield* Scope.fork(outerScope, 'parallel');
		const deployMount = walrusDeployMountPaths({
			stackRoot: spec.stackRoot,
			deployOutputDirHostPath: spec.deployHostMountPath,
			mountTarget: '/opt/walrus/runtime',
		});
		const readyTimeout = spec.readyTimeoutMs ?? DEFAULT_WALRUS_CLIENT_SERVICE_READY_TIMEOUT_MS;
		const stopGraceSeconds =
			spec.stopGraceSeconds ?? DEFAULT_WALRUS_CLIENT_SERVICE_STOP_GRACE_SECONDS;

		const startOne = (
			role: WalrusClientServiceRole,
			image: ImageRef,
			options: WalrusClientServiceOptions,
		): Effect.Effect<WalrusClientService, WalrusPluginError, Scope.Scope> =>
			Effect.gen(function* () {
				const containerName = walrusClientServiceContainerName({
					app: spec.app,
					stack: spec.stack,
					walrusName: spec.walrusName,
					role,
				});

				yield* setCurrentPluginPhase(`creating Walrus ${role} container ${containerName}`);
				const ensureService: Effect.Effect<ContainerHandle, WalrusPluginError, Scope.Scope> =
					ensureManagedContainer<WalrusPluginError>({
						runtime,
						identity: { app: spec.app, stack: spec.stack },
						plugin: 'walrus',
						role,
						spec: {
							name: containerName,
							image,
							recreate: 'on-config-change',
							configHash: walrusClientServiceConfigHash({
								role,
								deployConfigHash: spec.deployConfigHash,
								deploySourceHostPath: deployMount.sourceHostPath,
								deployMountTarget: deployMount.mountTarget,
								containerPort: options.port,
								walrusNetworkName: spec.walrusNetworkName,
								suiNetworkName: spec.suiNetworkName,
								suiRpcUrlInNetwork: spec.suiRpcUrlInNetwork,
							}),
							env: {
								DEPLOY_OUTPUT_DIR: deployMount.outputDirInContainer,
								SUI_RPC_URL: spec.suiRpcUrlInNetwork,
								WALRUS_CLIENT_WALLET_NODE,
								WALRUS_CLIENT_SERVICE_BIND_ADDRESS: `0.0.0.0:${options.port}`,
								WALRUS_CONTAINER_PORT: String(options.port),
							},
							command: [role],
							networkAttach: [spec.walrusNetworkName, spec.suiNetworkName],
							extraHosts: HOST_GATEWAY_EXTRA_HOSTS,
							mounts: [
								{
									source: deployMount.sourceHostPath,
									target: deployMount.mountTarget,
									readonly: true,
								},
							],
							stopGraceSeconds,
						},
						mapError: (cause) =>
							walrusPluginError(
								role,
								`walrus ${role} ensureContainer failed: ${cause.reason}: ${cause.detail}`,
								{ cause },
							),
					});
				const handle = yield* Scope.provide(ensureService, serviceStopScope);

				yield* setCurrentPluginPhase(`waiting for Walrus ${role} on 127.0.0.1:${options.port}`);
				yield* waitForProbe({
					label: `walrus.${role}`,
					timeoutMs: readyTimeout,
					intervalMs: SERVICE_READY_PROBE_INTERVAL_MS,
					probe: () =>
						runtime
							.exec(handle, ['sh', '-c', `nc -z 127.0.0.1 ${options.port}`])
							.pipe(Effect.map(exitCodeProbeResult)),
				}).pipe(
					Effect.mapError((cause) => {
						if (cause instanceof ProbeTimeoutError) {
							return walrusPluginError(
								role,
								`walrus ${role} never became ready within ${readyTimeout}ms ` +
									`(container=${containerName}, probe=127.0.0.1:${options.port}).`,
								{ cause: cause.lastError ?? cause.lastNotReady ?? cause },
							);
						}
						return walrusPluginError(
							role,
							`walrus ${role} ready-probe exec failed: ${cause.reason}: ${cause.detail}`,
							{ cause },
						);
					}),
				);

				return { role, containerName, containerPort: options.port };
			});

		const [aggregator, publisher] = yield* Effect.all(
			[
				spec.options.aggregator === null || spec.images.aggregator === null
					? Effect.succeed(null)
					: startOne('aggregator', spec.images.aggregator, spec.options.aggregator),
				spec.options.publisher === null || spec.images.publisher === null
					? Effect.succeed(null)
					: startOne('publisher', spec.images.publisher, spec.options.publisher),
			],
			{ concurrency: 'unbounded' },
		);

		return { aggregator, publisher };
	});
