import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import type { RoutableDecl } from '../../src/contracts/routable.ts';
import {
	DEFAULT_TRAEFIK_IMAGE,
	layerDockerUpstreamResolver,
	layerEntrypointRegistry,
	layerRouterConfigLiteral,
	layerRouterService,
	layerTraefikContainerOpsDocker,
	makeRouterProfile,
	RouterService,
	type EndpointUrl,
} from '../../src/orchestrators/router/index.ts';
import { appName, chainId, stackName } from '../../src/substrate/brand.ts';
import { buildSubstrateLayers } from '../../src/substrate/runtime/run.ts';

const SERVICE_IMAGE = 'busybox:1.36';
const SERVICE_PORT = 8080;
const ENTRYPOINT_NAME = 'router-real-http';

const docker = (args: ReadonlyArray<string>, timeout = 60_000): SpawnSyncReturns<string> =>
	spawnSync('docker', [...args], { encoding: 'utf8', timeout });

const dockerReachable = (): { readonly ok: boolean; readonly detail: string } => {
	const res = docker(['info', '--format', '{{.ServerVersion}}'], 5_000);
	if (res.status !== 0) {
		return { ok: false, detail: `docker info failed: status=${res.status}: ${res.stderr}` };
	}
	return { ok: true, detail: res.stdout.trim() };
};

const chooseHighPort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => {
				if (address !== null && typeof address === 'object') {
					resolve(address.port);
					return;
				}
				reject(new Error('could not reserve an ephemeral router e2e port'));
			});
		});
	});

const dockerJson = <T>(args: ReadonlyArray<string>): T => {
	const res = docker(args);
	if (res.status !== 0) {
		throw new Error(`docker ${args.join(' ')} failed: ${res.stderr}`);
	}
	return JSON.parse(res.stdout.trim()) as T;
};

const inspectHostPortBindings = (containerName: string): Readonly<Record<string, unknown>> => {
	const parsed = dockerJson<unknown>([
		'inspect',
		'--format',
		'{{json .HostConfig.PortBindings}}',
		containerName,
	]);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	return parsed as Readonly<Record<string, unknown>>;
};

const inspectNetworkNames = (containerName: string): ReadonlyArray<string> => {
	const parsed = dockerJson<unknown>([
		'inspect',
		'--format',
		'{{json .NetworkSettings.Networks}}',
		containerName,
	]);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
	return Object.keys(parsed).sort();
};

const candidateSubnets = (): ReadonlyArray<string> => {
	const out: string[] = [];
	for (const thirdOctet of [251, 252, 253, 254]) {
		for (let secondOctet = 16; secondOctet < 32; secondOctet += 1) {
			out.push(`10.${thirdOctet}.${secondOctet}.0/24`);
		}
	}
	for (let thirdOctet = 200; thirdOctet < 255; thirdOctet += 1) {
		out.push(`172.31.${thirdOctet}.0/24`);
	}
	return out;
};

const createRouterNetwork = (networkName: string): void => {
	let lastStderr = '';
	for (const subnet of candidateSubnets()) {
		const res = docker([
			'network',
			'create',
			'--driver',
			'bridge',
			'--subnet',
			subnet,
			'--label',
			'devstack.managed=true',
			'--label',
			'devstack.network=true',
			'--label',
			'devstack.app=router-real-traffic',
			'--label',
			'devstack.stack=e2e',
			networkName,
		]);
		if (res.status === 0) return;
		lastStderr = res.stderr;
		if (!/overlap|subnet|pool|address space/i.test(res.stderr)) break;
	}
	throw new Error(`docker network create ${networkName} failed: ${lastStderr}`);
};

const startHttpServiceContainer = (args: {
	readonly name: string;
	readonly networkName: string;
	readonly token: string;
}): void => {
	const res = docker(
		[
			'run',
			'-d',
			'--name',
			args.name,
			'--network',
			args.networkName,
			SERVICE_IMAGE,
			'sh',
			'-c',
			`mkdir -p /www && printf '${args.token}' > /www/index.html && httpd -f -p ${SERVICE_PORT} -h /www`,
		],
		120_000,
	);
	if (res.status !== 0) {
		throw new Error(`docker run ${SERVICE_IMAGE} failed: ${res.stderr}`);
	}
};

const cleanupDocker = (args: {
	readonly serviceName: string;
	readonly routerName: string;
	readonly networkName: string;
}) => {
	docker(['rm', '-f', args.serviceName], 20_000);
	docker(['rm', '-f', args.routerName], 20_000);
	docker(['network', 'rm', args.networkName], 20_000);
};

const getThroughRouter = (
	endpoint: EndpointUrl,
): Promise<{ readonly status: number | undefined; readonly body: string }> =>
	new Promise((resolve, reject) => {
		const url = new URL(endpoint.url);
		const req = request(
			{
				hostname: '127.0.0.1',
				port: url.port,
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers: { Host: url.hostname },
				timeout: 1_000,
			},
			(res) => {
				res.setEncoding('utf8');
				let body = '';
				res.on('data', (chunk) => {
					body += chunk;
				});
				res.on('end', () => {
					resolve({ status: res.statusCode, body });
				});
			},
		);
		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy(new Error(`timed out fetching ${endpoint.url}`));
		});
		req.end();
	});

const waitForRouterResponse = async (endpoint: EndpointUrl, token: string): Promise<void> => {
	const deadline = Date.now() + 30_000;
	let last: unknown = null;
	while (Date.now() < deadline) {
		try {
			const response = await getThroughRouter(endpoint);
			if (response.status === 200 && response.body.includes(token)) return;
			last = `status=${response.status} body=${response.body}`;
		} catch (error) {
			last = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`router did not return the service response before timeout: ${String(last)}`);
};

describe('router real Docker traffic', () => {
	it('routes to a container upstream over the router network without a service host port', async () => {
		const reachable = dockerReachable();
		if (!reachable.ok) {
			console.warn(`router-real-traffic: skipping — ${reachable.detail}`);
			return;
		}

		const suffix = `${Date.now()}-${process.pid}`;
		const stateRoot = mkdtempSync(join(tmpdir(), 'devstack-router-real-traffic-'));
		const runtimeRoot = mkdtempSync(join(tmpdir(), 'devstack-router-real-traffic-runtime-'));
		const entrypointPort = await chooseHighPort();
		const profile = makeRouterProfile({
			userId: `router-e2e-${suffix}`,
			dockerContextId: `docker-e2e-${suffix}`,
			stateRoot,
			namePrefix: 'devstack-router-e2e',
		});
		const serviceName = `devstack-router-e2e-service-${suffix}`;
		const token = `router-real-traffic-${suffix}`;
		const identity = {
			app: appName(`router-e2e-${process.pid}`),
			stack: stackName('main'),
			chain: chainId('sui:local'),
		};
		const route: RoutableDecl = {
			kind: 'routable',
			endpointName: ENTRYPOINT_NAME,
			dispatchId: {
				compositeKey: `router-real-traffic.${suffix}`,
				role: 'api',
			},
			upstream: {
				type: 'container',
				containerName: serviceName,
				containerPort: SERVICE_PORT,
			},
			wireProtocol: 'http',
			cors: false,
		};

		createRouterNetwork(profile.networkName);

		const routerLayer = layerRouterService.pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					layerEntrypointRegistry([
						{ name: ENTRYPOINT_NAME, port: entrypointPort, protocol: 'http' },
					]),
					layerTraefikContainerOpsDocker,
					layerDockerUpstreamResolver(profile),
					layerRouterConfigLiteral({
						disabled: false,
						profile,
						image: DEFAULT_TRAEFIK_IMAGE,
					}),
				),
			),
		);

		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const router = yield* RouterService;
						const boot = yield* router.boot();
						expect(boot.containerId).not.toBeNull();
						expect(boot.networkId).not.toBeNull();

						yield* Effect.sync(() =>
							startHttpServiceContainer({
								name: serviceName,
								networkName: profile.networkName,
								token,
							}),
						);
						expect(inspectNetworkNames(serviceName)).toContain(profile.networkName);
						expect(Object.keys(inspectHostPortBindings(serviceName))).toEqual([]);

						const endpoint = yield* router.contributeRoute(route);
						expect(endpoint.endpointName).toBe(ENTRYPOINT_NAME);
						expect(endpoint.entrypointPort).toBe(entrypointPort);
						expect(endpoint.url).toBe(`http://${endpoint.hostname}:${entrypointPort}`);
						yield* Effect.promise(() => waitForRouterResponse(endpoint, token));
					}),
				).pipe(
					Effect.provide(routerLayer),
					Effect.provide(buildSubstrateLayers(identity, runtimeRoot)),
				),
			);
		} finally {
			cleanupDocker({
				serviceName,
				routerName: profile.containerName,
				networkName: profile.networkName,
			});
			rmSync(stateRoot, { recursive: true, force: true });
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	}, 180_000);
});
