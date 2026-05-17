// App-level projection of the devstack manifest. Pulls the shapes
// the UI cares about — the published managed_coin package, the declared
// accounts, the localnet RPC/faucet URLs — out of the generated
// stack handles (`./generated/{accounts,services,packages,captured}.ts`)
// so app code never touches the raw manifest.

import { accounts } from '../generated/accounts.js';
import { captured } from '../generated/captured.js';
import { packages } from '../generated/packages.js';
import { services } from '../generated/services.js';

const managedCoin = packages.managed_coin;
const packageId = managedCoin?.id ?? '0x0';
const managedCoinCaptured = (captured as Record<string, Record<string, string> | undefined>)
	.managed_coin;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	packageId,
	managedCoinType: `${packageId}::managed_coin::MANAGED_COIN`,
	treasuryCapId: managedCoinCaptured?.treasuryCapId ?? '',
	metadataId: managedCoinCaptured?.metadataId ?? '',
	upgradeCapId: managedCoinCaptured?.upgradeCapId ?? '',
	accounts: accounts as Record<'alice' | 'bob' | 'carol', string>,
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
export type AccountName = keyof Deployment['accounts'];
