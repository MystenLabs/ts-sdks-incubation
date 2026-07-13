import type { EntrypointDecl, RoutableDecl } from '../../contracts/routable.ts';

export const SUI_RPC_ENDPOINT_NAME = 'rpc' as const;
export const SUI_FAUCET_ENDPOINT_NAME = 'faucet' as const;
export const SUI_GRAPHQL_ENDPOINT_NAME = 'graphql' as const;

export const SUI_RPC_ENTRYPOINT_PORT = 9000;
export const SUI_FAUCET_ENTRYPOINT_PORT = 9123;
export const SUI_GRAPHQL_ENTRYPOINT_PORT = 9125;

export const SUI_ENTRYPOINTS: ReadonlyArray<EntrypointDecl> = [
	{ name: SUI_RPC_ENDPOINT_NAME, port: SUI_RPC_ENTRYPOINT_PORT, protocol: 'h2c' },
	{ name: SUI_FAUCET_ENDPOINT_NAME, port: SUI_FAUCET_ENTRYPOINT_PORT, protocol: 'http' },
	{ name: SUI_GRAPHQL_ENDPOINT_NAME, port: SUI_GRAPHQL_ENTRYPOINT_PORT, protocol: 'http' },
];

export const makeSuiLocalRoutables = (parts: {
	readonly containerName: string;
	readonly includeGraphql: boolean;
}): ReadonlyArray<RoutableDecl> => [
	{
		kind: 'routable',
		endpointName: SUI_RPC_ENDPOINT_NAME,
		dispatchId: {
			serviceKey: 'sui.local',
			role: SUI_RPC_ENDPOINT_NAME,
		},
		upstream: {
			type: 'container',
			containerName: parts.containerName,
			containerPort: SUI_RPC_ENTRYPOINT_PORT,
		},
		cors: true,
		wireProtocol: 'h2c',
	},
	{
		kind: 'routable',
		endpointName: SUI_FAUCET_ENDPOINT_NAME,
		dispatchId: {
			serviceKey: 'sui.local',
			role: SUI_FAUCET_ENDPOINT_NAME,
		},
		upstream: {
			type: 'container',
			containerName: parts.containerName,
			containerPort: SUI_FAUCET_ENTRYPOINT_PORT,
		},
		cors: true,
		wireProtocol: 'http',
	},
	...(parts.includeGraphql
		? [
				{
					kind: 'routable',
					endpointName: SUI_GRAPHQL_ENDPOINT_NAME,
					dispatchId: {
						serviceKey: 'sui.local',
						role: SUI_GRAPHQL_ENDPOINT_NAME,
					},
					upstream: {
						type: 'container',
						containerName: parts.containerName,
						containerPort: SUI_GRAPHQL_ENTRYPOINT_PORT,
					},
					cors: true,
					wireProtocol: 'http',
				} satisfies RoutableDecl,
			]
		: []),
];

export const makeSuiForkRoutables = (parts: {
	readonly containerName: string;
}): ReadonlyArray<RoutableDecl> => [
	{
		kind: 'routable',
		endpointName: SUI_RPC_ENDPOINT_NAME,
		dispatchId: {
			serviceKey: 'sui.fork',
			role: SUI_RPC_ENDPOINT_NAME,
		},
		upstream: {
			type: 'container',
			containerName: parts.containerName,
			containerPort: SUI_RPC_ENTRYPOINT_PORT,
		},
		cors: true,
		wireProtocol: 'h2c',
	},
];
