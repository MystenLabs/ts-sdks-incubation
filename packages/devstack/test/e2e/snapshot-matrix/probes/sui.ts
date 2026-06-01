// Sui chain-state probe.
//
// State = a funded recipient address. createState transfers a fixed amount
// of SUI from the fresh actor to a brand-new recipient (so each S1/S2/S3 has
// a distinct, independently-checkable recipient); exists = recipient balance
// is non-zero. A snapshot taken between S1 and S2 must, after restore, leave
// S1's recipient funded and S2's recipient empty.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { getSuiBalance, signAndExecuteAs, type ProbeEnv } from '../clients.ts';
import type { Probe } from '../probe.ts';

interface SuiHandle {
	readonly recipient: string;
}

const TRANSFER_MIST = 100_000_000n; // 0.1 SUI

export const suiProbe: Probe<SuiHandle> = {
	name: 'sui',
	async createState(env: ProbeEnv): Promise<SuiHandle> {
		const recipient = Ed25519Keypair.generate().toSuiAddress();
		await signAndExecuteAs(env.suiClient, env.keypair, (tx) => {
			const coin = tx.splitCoins(tx.gas, [TRANSFER_MIST]);
			tx.transferObjects([coin], tx.pure.address(recipient));
		});
		return { recipient };
	},
	async exists(env: ProbeEnv, handle: SuiHandle): Promise<boolean> {
		const balance = await getSuiBalance(env.suiClient, handle.recipient);
		return balance > 0n;
	},
};
