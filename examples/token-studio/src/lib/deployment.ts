// App-level projection of the codegen-emitted typed manifest. Pulls the
// shapes the UI cares about — the published managed_coin package, the
// declared accounts, the localnet RPC/faucet URLs — out of the generic
// registry into the named fields components reach for.

import { selectAccountMap, selectPackage, selectService } from '@mysten-incubation/devstack';
import { manifest } from '../generated/manifest.js';

const managedCoin = selectPackage(manifest, 'managed_coin');
const packageId = managedCoin?.packageId ?? '0x0';

export const deployment = {
	rpcUrl: selectService(manifest, 'sui-rpc')?.url ?? '',
	faucetUrl: selectService(manifest, 'sui-faucet')?.url,
	packageId,
	managedCoinType: `${packageId}::managed_coin::MANAGED_COIN`,
	treasuryCapId: managedCoin?.captured.treasuryCapId ?? '',
	metadataId: managedCoin?.captured.metadataId ?? '',
	upgradeCapId: managedCoin?.captured.upgradeCapId ?? '',
	accounts: selectAccountMap(manifest) as Record<'alice' | 'bob' | 'carol', string>,
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
export type AccountName = keyof Deployment['accounts'];
