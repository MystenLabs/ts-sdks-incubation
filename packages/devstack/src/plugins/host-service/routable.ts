import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

export const HOST_SERVICE_DEFAULT_ENDPOINT_NAME = 'dev' as const;
export const HOST_SERVICE_DEFAULT_ENTRYPOINT_PORT = 5175;

export const HOST_SERVICE_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{
		name: HOST_SERVICE_DEFAULT_ENDPOINT_NAME,
		port: HOST_SERVICE_DEFAULT_ENTRYPOINT_PORT,
		protocol: 'http',
	},
];

export const makeHostServiceRoutable = (parts: {
	readonly endpointName: string;
	readonly serviceName: string;
	readonly port: number;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: parts.endpointName,
	dispatchId: {
		serviceKey: `host-service.${parts.serviceName}`,
		role: parts.endpointName,
	},
	upstream: { type: 'host-loopback', port: parts.port },
	cors: true,
	wireProtocol: 'http',
	readiness: 'deferred',
});
