import { useCurrentClient } from '@mysten/dapp-kit-react';
import { Card, Field } from '@mysten-incubation/devstack/react/ui';
import { useState } from 'react';

import { deployment } from '../lib/deployment.js';
import { buildTransferTx, parseStudioAmount, shortAddress } from '../lib/coin.js';
import { useInvalidateCoinReads, useSignAndExecute } from '../lib/queries.js';

export function TransferForm({ self }: { self: string }) {
	const client = useCurrentClient();
	const invalidate = useInvalidateCoinReads();
	const { mutateAsync, isPending } = useSignAndExecute();

	const others = Object.entries(deployment.accounts).filter(([, addr]) => addr !== self);
	const firstOther = (others[0]?.[1] ?? '') as string;

	const [recipient, setRecipient] = useState<string>(firstOther);
	const [amount, setAmount] = useState('10');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			const raw = parseStudioAmount(amount);
			if (raw <= 0n) throw new Error('Amount must be greater than zero');
			const transaction = await buildTransferTx({
				client,
				sender: self,
				amount: raw,
				recipient,
			});
			const result = await mutateAsync(transaction);
			invalidate();
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<Card title="Transfer" subtitle="Send STUDIO from your account to another address">
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
							{others.map(([name, addr]) => (
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
					disabled={isPending || !recipient}
					className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
				>
					{isPending ? 'Submitting…' : 'Transfer'}
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
