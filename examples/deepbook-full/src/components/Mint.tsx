import { useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { Card } from '../ui/Card.js';
import { useSignAndExecute } from '../lib/queries.js';
import { deepbookConfig } from '../generated/deepbook-config.js';
import { packages } from '../generated/packages.js';
import { accounts } from '../generated/accounts.js';

/** Mint DEEP or USDC from the publisher's TreasuryCap to the connected
 *  account. The deepbook local-deploy primitive captures the DEEP
 *  TreasuryCap as `pkg.captured.deepTreasuryId`; the USDC TreasuryCap
 *  surfaces under the same `captured` map. */
export function Mint({ self }: { self: string }) {
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['balance']],
	});

	const deepbookPkg = (
		packages as Record<string, { id: string; captured?: Record<string, unknown> }>
	).deepbook;
	const deepTreasuryId = deepbookConfig.packageIds.DEEP_TREASURY_ID;
	const deepCoinType = deepbookConfig.coins.DEEP?.type;

	async function mintDeep(amount: bigint) {
		if (!deepTreasuryId || !deepCoinType) {
			setError('DEEP TreasuryCap not in deepbookConfig');
			return;
		}
		try {
			setError(null);
			const tx = new Transaction();
			// Generic Move treasury::mint_and_transfer: TreasuryCap + amount
			// + recipient. The deepbook local-deploy publishes the `token`
			// sub-package which exports the standard `Coin<DEEP>` shape.
			tx.moveCall({
				target: `0x2::coin::mint_and_transfer`,
				typeArguments: [deepCoinType],
				arguments: [tx.object(deepTreasuryId), tx.pure.u64(amount), tx.pure.address(self)],
			});
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function mintUsdc(amount: bigint) {
		const usdcTreasuryId =
			typeof deepbookPkg?.captured?.usdcTreasuryId === 'string'
				? (deepbookPkg.captured.usdcTreasuryId as string)
				: undefined;
		const usdcCoinType = deepbookConfig.coins.USDC?.type;
		if (!usdcTreasuryId || !usdcCoinType) {
			setError('USDC TreasuryCap not in deepbookConfig.captured');
			return;
		}
		try {
			setError(null);
			const tx = new Transaction();
			tx.moveCall({
				target: `0x2::coin::mint_and_transfer`,
				typeArguments: [usdcCoinType],
				arguments: [tx.object(usdcTreasuryId), tx.pure.u64(amount), tx.pure.address(self)],
			});
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	const isAlice = self === accounts.alice;
	const recipient = isAlice ? 'alice' : self === accounts.bob ? 'bob' : 'self';
	void recipient;

	return (
		<Card title="Mint" subtitle="Mint DEEP / USDC from the publisher's TreasuryCap">
			<div className="flex gap-2 flex-wrap">
				<button
					data-testid="mint-deep-100"
					type="button"
					disabled={isPending}
					onClick={() => mintDeep(100_000_000n)}
					className="rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium px-3 py-1.5"
				>
					Mint 100 DEEP
				</button>
				<button
					data-testid="mint-usdc-100"
					type="button"
					disabled={isPending}
					onClick={() => mintUsdc(100_000_000n)}
					className="rounded-md bg-sky-600 hover:bg-sky-700 disabled:bg-neutral-400 text-white text-sm font-medium px-3 py-1.5"
				>
					Mint 100 USDC
				</button>
			</div>
			{error && <p className="text-sm text-red-600 dark:text-red-400 mt-3">{error}</p>}
			{lastDigest && (
				<p className="text-xs text-neutral-500 break-all mt-2">
					Last tx: <span className="font-mono">{lastDigest}</span>
				</p>
			)}
		</Card>
	);
}
