// App-level projection of the devstack manifest. Pulls the shapes
// the UI cares about — the published managed_coin package, the declared
// accounts, the localnet RPC/faucet URLs — out of the generated
// stack handles (`@generated/config.js`, `@generated/coins.js`, and the
// dev-only `@devstack-dev/accounts.js`) so app code never touches the
// raw manifest.
//
// `coins.managed_coin.{treasuryCapId, metadataId, fullCoinType}` are populated by
// coin auto-discovery on every publish (see
// `packages/devstack/notes/coin-auto-discovery.md`); the generated key
// follows the witness struct name.

import { accounts } from '@devstack-dev/accounts.js';
import { coins } from '@generated/coins.js';
import { config } from '@generated/config.js';

const managedCoin = config.packages.managed_coin;
const packageId = managedCoin?.packageId ?? '0x0';
const studio = coins.managed_coin;
const network = config.networks[config.network];

export const deployment = {
	rpcUrl: network?.rpc ?? '',
	faucetUrl: network?.faucet,
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
