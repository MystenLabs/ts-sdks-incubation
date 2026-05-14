// App-level projection of the devstack manifest. Surfaces the
// connect_four package id and the openLobby shared object the UI
// reaches for, plus a flat account name → address map.

import { manifest } from '../generated/manifest.js';

const accountMap = Object.fromEntries(manifest.accounts.map((a) => [a.name, a.address]));

export const deployment = {
	rpcUrl: manifest.endpoints.find((e) => e.name === 'sui-rpc')?.url ?? '',
	faucetUrl: manifest.endpoints.find((e) => e.name === 'sui-faucet')?.url,
	accounts: accountMap,
	connectFourPackageId: manifest.packages.find((p) => p.name === 'connect_four')?.packageId,
	openLobbyId: manifest.extras.openLobbyId as string | undefined,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 && deployment.connectFourPackageId !== undefined;

export type Deployment = typeof deployment;
