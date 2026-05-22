import type { RoutableDecl } from '../../contracts/routable.ts';

export const HOST_SERVICE_DEFAULT_ENDPOINT_NAME = 'dev' as const;

export const makeHostServiceRoutable = (parts: {
	readonly endpointName: string;
	readonly serviceName: string;
	readonly port: number;
}): RoutableDecl => ({
	kind: 'routable',
	endpointName: parts.endpointName,
	dispatchId: {
		compositeKey: `host-service.${parts.serviceName}`,
		role: parts.endpointName,
	},
	upstream: { type: 'host-loopback', port: parts.port },
	cors: true,
	wireProtocol: 'http',
});
