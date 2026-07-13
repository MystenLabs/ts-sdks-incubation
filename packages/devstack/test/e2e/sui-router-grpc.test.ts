// E2E regression guard for router-fronted Sui gRPC.
//
// The Sui plugin publishes one public RPC URL through Traefik. JSON-RPC can
// survive a plain HTTP route, but native gRPC needs h2c upstream proxying.
// The same public URL must continue serving the SDK's default grpc-web
// transport, so this smoke checks both paths.

import { createServer } from 'node:net';
import { connect, constants } from 'node:http2';

import { afterAll, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import type { EntrypointDecl } from '../../src/contracts/routable.ts';
import { defineDevstack, readStackEngine } from '../../src/api/define-devstack.ts';
import { sui } from '../../src/plugins/sui/index.ts';
import {
	SUI_FAUCET_ENDPOINT_NAME,
	SUI_RPC_ENDPOINT_NAME,
	SUI_ENTRYPOINTS,
} from '../../src/plugins/sui/routable.ts';
import { runBoot, type BootScopeContext } from './boot-config-impl.ts';
import {
	dockerReachable,
	pruneManagedImagesForApp,
	removeManagedContainersForAppStack,
} from './docker-prune.ts';

const APP = 'sui-router-grpc';
const STACK = 'router-grpc';

interface ResolvedSuiRpc {
	readonly rpcUrl: string;
	readonly chainId: string;
}

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

const findSui = (ctx: BootScopeContext): ResolvedSuiRpc => {
	for (const [key, value] of ctx.resolvedValues) {
		if (!/^sui#\d+$/.test(key)) continue;
		if (
			value !== null &&
			typeof value === 'object' &&
			'rpcUrl' in value &&
			typeof value.rpcUrl === 'string' &&
			'chainId' in value &&
			typeof value.chainId === 'string'
		) {
			return { rpcUrl: value.rpcUrl, chainId: value.chainId };
		}
		throw new Error(`resolved ${key} does not carry rpcUrl/chainId strings`);
	}
	throw new Error(`no sui#N in [${[...ctx.resolvedValues.keys()].join(', ')}]`);
};

const fetchServiceInfoThroughRouter = async (rpcUrl: string) => {
	const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'localnet' });
	return client.ledgerService.getServiceInfo({}, { timeout: 10_000 }).response;
};

const fetchRouteProbe = async (
	rpcUrl: string,
): Promise<{ readonly status: number; readonly routeId: string }> => {
	const response = await fetch(rpcUrl);
	return {
		status: response.status,
		routeId: response.headers.get('x-devstack-route-id') ?? '',
	};
};

const waitForRoute = async (rpcUrl: string): Promise<void> => {
	const deadline = Date.now() + 15_000;
	let last: { readonly status: number; readonly routeId: string } | unknown = null;
	while (Date.now() < deadline) {
		try {
			const probe = await fetchRouteProbe(rpcUrl);
			if (probe.routeId !== '') return;
			last = probe;
		} catch (cause) {
			last = cause;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`router route did not become ready: ${JSON.stringify(last)}`);
};

const fetchNativeGrpcServiceInfoThroughRouter = (
	rpcUrl: string,
): Promise<{
	readonly httpStatus: number;
	readonly grpcStatus: string;
	readonly routeId: string;
	readonly dataBytes: number;
}> =>
	new Promise((resolve, reject) => {
		const url = new URL(rpcUrl);
		const client = connect(`http://127.0.0.1:${url.port}`);
		let settled = false;
		let httpStatus = 0;
		let grpcStatus = '';
		let routeId = '';
		const chunks: Uint8Array[] = [];
		const timer = setTimeout(
			() => settle(reject, new Error('native gRPC probe timed out')),
			10_000,
		);

		const settle = <T>(fn: (value: T) => void, value: T): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.close();
			fn(value);
		};

		client.on('error', (cause) => settle(reject, cause));
		const req = client.request({
			[constants.HTTP2_HEADER_METHOD]: constants.HTTP2_METHOD_POST,
			[constants.HTTP2_HEADER_SCHEME]: 'http',
			[constants.HTTP2_HEADER_AUTHORITY]: url.hostname,
			[constants.HTTP2_HEADER_PATH]: '/sui.rpc.v2.LedgerService/GetServiceInfo',
			[constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
			[constants.HTTP2_HEADER_TE]: 'trailers',
		});
		req.on('response', (headers) => {
			const status = headers[constants.HTTP2_HEADER_STATUS];
			httpStatus = typeof status === 'number' ? status : Number(status ?? 0);
			const statusHeader = headers['grpc-status'];
			if (typeof statusHeader === 'string') grpcStatus = statusHeader;
			const readyHeader = headers['x-devstack-route-id'];
			if (typeof readyHeader === 'string') routeId = readyHeader;
		});
		req.on('trailers', (headers) => {
			const status = headers['grpc-status'];
			if (typeof status === 'string') grpcStatus = status;
		});
		req.on('data', (chunk: Buffer | Uint8Array) => {
			chunks.push(chunk);
		});
		req.on('error', (cause) => settle(reject, cause));
		req.on('end', () =>
			settle(resolve, {
				httpStatus,
				grpcStatus,
				routeId,
				dataBytes: Buffer.concat(chunks).byteLength,
			}),
		);
		req.end(Buffer.alloc(5));
	});

describe('sui router gRPC @e2e', () => {
	afterAll(() => {
		removeManagedContainersForAppStack(APP, STACK);
		pruneManagedImagesForApp(APP);
	});

	it('serves grpc-web and native gRPC through the router-fronted RPC URL', async () => {
		const docker = dockerReachable();
		if (!docker.ok) {
			console.warn(`sui-router-grpc: skipping — ${docker.detail}`);
			return;
		}
		const rpcPort = await chooseHighPort();
		let faucetPort = await chooseHighPort();
		while (faucetPort === rpcPort) faucetPort = await chooseHighPort();
		const routerEntrypoints: ReadonlyArray<EntrypointDecl> = SUI_ENTRYPOINTS.filter(
			(entrypoint) =>
				entrypoint.name === SUI_RPC_ENDPOINT_NAME || entrypoint.name === SUI_FAUCET_ENDPOINT_NAME,
		).map((entrypoint) =>
			entrypoint.name === SUI_RPC_ENDPOINT_NAME
				? { ...entrypoint, port: rpcPort }
				: { ...entrypoint, port: faucetPort },
		);

		const engine = readStackEngine(
			defineDevstack({
				members: [sui({ mode: 'local', indexer: false })],
				stackName: STACK,
			}),
		);

		const boot = await runBoot({
			stack: engine,
			appName: APP,
			stackName: STACK,
			useRealRouter: true,
			routerEntrypoints,
			withinScope: (ctx) =>
				Effect.tryPromise({
					try: async () => {
						const resolved = findSui(ctx);
						expect(resolved.rpcUrl).toContain(`.${APP}.localhost:9000`);
						const routerRpcUrl = new URL(resolved.rpcUrl);
						routerRpcUrl.port = String(rpcPort);

						await waitForRoute(routerRpcUrl.href);

						const native = await fetchNativeGrpcServiceInfoThroughRouter(routerRpcUrl.href);
						expect(native.httpStatus, JSON.stringify(native)).toBe(200);
						expect(native.grpcStatus).toBe('0');
						expect(native.dataBytes).toBeGreaterThan(5);

						const info = await fetchServiceInfoThroughRouter(routerRpcUrl.href);
						expect(info.chainId).toBe(resolved.chainId);
					},
					catch: (cause) => cause,
				}),
		});

		expect(boot.failures, JSON.stringify(boot.failures)).toEqual([]);
		expect(boot.routerAppliedRoutes.find((route) => route.entrypointName === 'rpc')).toMatchObject({
			entrypointPort: rpcPort,
			wireProtocol: 'h2c',
			upstreamUrl: expect.stringMatching(/^h2c:\/\//),
		});
	}, 180_000);
});
