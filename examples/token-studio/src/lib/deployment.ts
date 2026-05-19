// App-level projection of the devstack manifest. Pulls the shapes
// the UI cares about — the published managed_coin package, the declared
// accounts, the localnet RPC/faucet URLs — out of the generated
// stack handles (`./generated/{accounts,services,packages,coins}.ts`)
// so app code never touches the raw manifest.
//
// `coins.STUDIO.{treasuryCapId, metadataId, type}` are populated by
// coin auto-discovery on every publish (see
// `packages/devstack/notes/coin-auto-discovery.md`); the `STUDIO` key
// matches the symbol declared in the Move source's
// `coin::create_currency` call.

import { accounts } from '../generated/accounts.js';
import { coins } from '../generated/coins.js';
import { packages } from '../generated/packages.js';
import { services } from '../generated/services.js';

const managedCoin = packages.managed_coin;
const packageId = managedCoin?.id ?? '0x0';
const studio = coins.STUDIO;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	packageId,
	managedCoinType: studio?.type ?? `${packageId}::managed_coin::MANAGED_COIN`,
	treasuryCapId: studio?.treasuryCapId ?? '',
	metadataId: studio?.metadataId ?? '',
	upgradeCapId: '',
	accounts: accounts as Record<'alice' | 'bob' | 'carol', string>,
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
export type AccountName = keyof Deployment['accounts'];
