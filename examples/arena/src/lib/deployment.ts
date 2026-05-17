// App-level projection of the devstack manifest. Surfaces the
// connect_four package id and the openLobby shared object the UI
// reaches for, plus a flat account name → address map — all sourced
// from the generated stack handles (`./generated/{accounts,services,
// extras,packages}.ts`) so app code never touches the raw manifest.

import { accounts } from '../generated/accounts.js';
import { extras } from '../generated/extras.js';
import { packages } from '../generated/packages.js';
import { services } from '../generated/services.js';

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	accounts,
	connectFourPackageId: packages.connect_four?.id,
	openLobbyId:
		'openLobbyId' in extras ? (extras as { openLobbyId?: string }).openLobbyId : undefined,
} as const;

export const isDeployed: boolean =
	Object.keys(deployment.accounts).length > 0 && deployment.connectFourPackageId !== undefined;

export type Deployment = typeof deployment;
