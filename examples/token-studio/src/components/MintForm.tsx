import { Transaction } from '@mysten/sui/transactions';
import { Card, Field } from '@mysten-incubation/devstack/react/ui';
import { useState } from 'react';

import { deployment } from '../generated/deployment.js';
import * as managedCoin from '../generated/sui/managed_coin/managed_coin.js';
import { TREASURY_CAP_ID, parseStudioAmount, shortAddress } from '../lib/coin.js';
import { useInvalidateCoinReads, useSignAndExecute } from '../lib/queries.js';

export function MintForm() {
	const invalidate = useInvalidateCoinReads();
	const { mutateAsync, isPending } = useSignAndExecute();

	const [recipient, setRecipient] = useState<string>(deployment.accounts.bob);
	const [amount, setAmount] = useState('100');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			const raw = parseStudioAmount(amount);
			if (raw <= 0n) throw new Error('Amount must be greater than zero');
			const tx = new Transaction();
			tx.add(managedCoin.mint({ arguments: [TREASURY_CAP_ID, raw, recipient] }));
			const result = await mutateAsync(tx);
			invalidate();
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<Card title="Mint" subtitle="Only the TreasuryCap holder (alice) can mint new STUDIO">
			<form className="space-y-3" onSubmit={onSubmit}>
				<Field
					label="Recipient"
					render={(id) => (
						<select
							id={id}
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={recipient}
							onChange={(e) => setRecipient(e.target.value)}
						>
							{Object.entries(deployment.accounts).map(([name, addr]) => (
								<option key={name} value={addr}>
									{name} ({shortAddress(addr)})
								</option>
							))}
						</select>
					)}
				/>
				<Field
					label="Amount (STUDIO)"
					render={(id) => (
						<input
							id={id}
							type="text"
							inputMode="decimal"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
						/>
					)}
				/>
				<button
					type="submit"
					disabled={isPending}
					className="w-full rounded-md bg-sky-600 hover:bg-sky-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
				>
					{isPending ? 'Minting…' : 'Mint'}
				</button>
				{error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
				{lastDigest && (
					<p className="text-xs text-neutral-500 break-all">
						Last tx: <span className="font-mono">{lastDigest}</span>
					</p>
				)}
			</form>
		</Card>
	);
}
