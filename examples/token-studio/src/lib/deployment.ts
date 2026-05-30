// App-level projection of the devstack manifest. Pulls the shapes
// the UI cares about — the published managed_coin package, the declared
// accounts, the localnet RPC/faucet URLs — out of the generated
// stack handles (`./generated/{accounts,services,packages,coins}.ts`)
// so app code never touches the raw manifest.
//
// `coins.managed_coin.{treasuryCapId, metadataId, fullCoinType}` are populated by
// coin auto-discovery on every publish (see
// `packages/devstack/notes/coin-auto-discovery.md`); the generated key
// follows the witness struct name.

import { accounts } from '@generated/accounts.js';
import { coins } from '@generated/coins.js';
import { packages } from '@generated/packages.js';
import { services } from '@generated/services.js';

const managedCoin = packages.managed_coin;
const packageId = managedCoin?.packageId ?? '0x0';
const studio = coins.managed_coin;

export const deployment = {
	rpcUrl: services.sui?.rpc.url ?? '',
	faucetUrl: services.sui?.faucet?.url,
	packageId,
	managedCoinType: studio?.fullCoinType ?? `${packageId}::managed_coin::MANAGED_COIN`,
	treasuryCapId: studio?.treasuryCapId ?? '',
	metadataId: studio?.metadataId ?? '',
	upgradeCapId: '',
	accounts: {
		alice: accounts.alice.address,
		bob: accounts.bob.address,
		carol: accounts.carol.address,
	},
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
export type AccountName = keyof Deployment['accounts'];
