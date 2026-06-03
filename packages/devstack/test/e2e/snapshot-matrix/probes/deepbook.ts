// Deepbook DEX-state probe.
//
// State = a `BalanceManager` (has key+store) owned by a fresh recipient,
// with a SUI deposit (a non-zero internal balance — the "pool balances"
// notion). createState mints a BalanceManager, deposits SUI, and transfers
// it to a brand-new recipient.
//
// Survival is checked with `getObject` (fullnode), NOT `listOwnedObjects`
// (the postgres indexer): after an offline restore the indexer can lag the
// restored validator state, so an owner-index query misses objects the
// validator actually has. We resolve the manager's id via the owner index
// at creation time (when the indexer is consistent), then read it directly
// from the fullnode thereafter.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { deepbookOf, signAndExecuteAs, type ProbeEnv } from '../clients.ts';
import type { Probe } from '../probe.ts';

interface DeepbookHandle {
	readonly recipient: string;
	readonly balanceManagerId: string | undefined;
}

const SUI_COIN_TYPE = '0x2::sui::SUI';
const DEPOSIT_MIST = 100_000_000n; // 0.1 SUI

const balanceManagerType = (pkg: string): string => `${pkg}::balance_manager::BalanceManager`;

export const deepbookProbe: Probe<DeepbookHandle> = {
	name: 'deepbook',
	// The deepbook PACKAGE id IS cache-derived (it churns when the live deploy
	// cache is wiped — observable in the matrix run log as a fresh deepbookPkg),
	// but this probe's S1 IDENTITY is the on-chain `BalanceManager` OBJECT id,
	// captured at creation and read back via `getObject` against the same chain.
	// That object id does not depend on the (re-deployed) package id, so a cache
	// wipe leaves S1 resolving — the probe does NOT detect package-id orphaning.
	// We therefore assert deepbook's S1 SURVIVES the cache wipe; the cache-loss
	// loud-divergence property is proven by the walrus + vault-seal probes, whose
	// S1 identity is itself minted from the cache. (Promoting deepbook to a
	// cache-orphan probe would require checking the package id, not the manager
	// object — out of scope for this state-survival matrix.)
	orphansOnCacheLoss: false,
	async createState(env: ProbeEnv): Promise<DeepbookHandle> {
		const recipient = Ed25519Keypair.generate().toSuiAddress();
		const pkg = deepbookOf(env.ctx).packageId;
		await signAndExecuteAs(env.suiClient, env.keypair, (tx) => {
			const bm = tx.moveCall({ target: `${pkg}::balance_manager::new` });
			const coin = tx.splitCoins(tx.gas, [DEPOSIT_MIST]);
			tx.moveCall({
				target: `${pkg}::balance_manager::deposit`,
				typeArguments: [SUI_COIN_TYPE],
				arguments: [bm, coin],
			});
			tx.transferObjects([bm], tx.pure.address(recipient));
		});
		const page = await env.suiClient.core.listOwnedObjects({
			owner: recipient,
			type: balanceManagerType(pkg),
		});
		const balanceManagerId = (page.objects[0] as { objectId?: string } | undefined)?.objectId;
		return { recipient, balanceManagerId };
	},
	async exists(env: ProbeEnv, handle: DeepbookHandle): Promise<boolean> {
		if (handle.balanceManagerId === undefined) return false;
		try {
			const result = (await env.suiClient.core.getObject({
				objectId: handle.balanceManagerId,
			})) as { object?: unknown };
			return result.object != null;
		} catch {
			return false;
		}
	},
};
