import { Transaction } from '@mysten/sui/transactions';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { useEffect, useState } from 'react';

import { mint as buildMint } from '@generated/bindings/token_studio/managed_coin.js';
import { useCurrentWallet } from '@mysten/dapp-kit-react';
import { TREASURY_CAP_ID, parseStudioAmount, shortAddress } from '../lib/coin.js';
import { useInvalidateCoinReads, useSignAndExecute } from '../lib/queries.js';

export function MintForm() {
	const invalidate = useInvalidateCoinReads();
	const { mutateAsync, isPending } = useSignAndExecute();

	// The connected wallet's accounts (in DEV: alice/bob/carol), each carrying a
	// `label` = the devstack account name.
	const accounts = useCurrentWallet()?.accounts ?? [];
	// Default recipient: bob if present, else the first connected account.
	const defaultRecipient =
		accounts.find((a) => a.label === 'bob')?.address ?? accounts[0]?.address ?? '';

	const [recipient, setRecipient] = useState<string>(defaultRecipient);
	const [amount, setAmount] = useState('100');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	// Default the recipient once the connected-account list loads, if the
	// user hasn't picked one yet.
	useEffect(() => {
		if (!recipient && defaultRecipient) setRecipient(defaultRecipient);
	}, [recipient, defaultRecipient]);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			const raw = parseStudioAmount(amount);
			if (raw <= 0n) throw new Error('Amount must be greater than zero');
			const tx = new Transaction();
			// `buildMint` defaults its package to the `@local/managed_coin`
			// MVR name, which the client's `mvr.overrides` (see `dapp-kit.ts`)
			// resolves to the published managed_coin package id at call time.
			buildMint({
				arguments: {
					treasury: TREASURY_CAP_ID,
					amount: raw,
					recipient,
				},
			})(tx);
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
							{accounts.map(({ label, address }) => (
								<option key={address} value={address}>
									{label ?? address} ({shortAddress(address)})
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
