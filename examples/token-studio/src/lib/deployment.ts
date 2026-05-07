// App-level projection of the codegen-emitted typed manifest. Pulls the
// shapes the UI cares about — the published managed_coin package, the
// declared accounts, the localnet RPC/faucet URLs — out of the generic
// registry into the named fields components reach for.

import { manifest } from '../generated/manifest.js';

const managedCoin = manifest.registry.packages.find((p) => p.name === 'managed_coin');
const packageId = managedCoin?.packageId ?? '0x0';

export const deployment = {
	rpcUrl: manifest.registry.services.find((s) => s.name === 'sui-rpc')?.url ?? '',
	faucetUrl: manifest.registry.services.find((s) => s.name === 'sui-faucet')?.url,
	packageId,
	managedCoinType: `${packageId}::managed_coin::MANAGED_COIN`,
	treasuryCapId: managedCoin?.captured.treasuryCapId ?? '',
	metadataId: managedCoin?.captured.metadataId ?? '',
	upgradeCapId: managedCoin?.captured.upgradeCapId ?? '',
	accounts: Object.fromEntries(
		manifest.registry.accounts.map((a) => [a.name, a.address]),
	) as Record<'alice' | 'bob' | 'carol', string>,
} as const;

export const isDeployed: boolean = (deployment.packageId as string) !== '0x0';

export type Deployment = typeof deployment;
export type AccountName = keyof Deployment['accounts'];
