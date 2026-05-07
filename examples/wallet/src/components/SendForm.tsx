import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { useMemo, useState } from 'react';

import { deployment } from '../lib/deployment.js';
import { parseCoinAmount, shortAddress } from '../lib/format.js';
import { useInvalidateBalances, useSignAndExecute } from '../lib/queries.js';
import { buildSendTx } from '../lib/transactions.js';

export function SendForm({ self }: { self: string }) {
	const invalidate = useInvalidateBalances();
	const { mutateAsync, isPending } = useSignAndExecute();

	const others = Object.entries(deployment.accounts).filter(([, addr]) => addr !== self);
	const firstOther = (others[0]?.[1] ?? '') as string;
	const coins = deployment.coins;
	const firstCoin = coins[0];
	if (!firstCoin) throw new Error('SendForm: deployment.coins is empty');

	const [coinType, setCoinType] = useState<string>(firstCoin.coinType);
	const [recipient, setRecipient] = useState<string>(firstOther);
	const [amount, setAmount] = useState('1');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	const selectedCoin = useMemo(
		() => coins.find((c) => c.coinType === coinType) ?? firstCoin,
		[coins, coinType, firstCoin],
	);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			const raw = parseCoinAmount(amount, selectedCoin.decimals);
			if (raw <= 0n) throw new Error('Amount must be greater than zero');
			const transaction = await buildSendTx({
				coinType: selectedCoin.coinType,
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
		<Card title="Send" subtitle="Transfer any held coin to another seeded account">
			<form className="space-y-3" onSubmit={onSubmit}>
				<Field
					label="Coin"
					render={(id) => (
						<select
							id={id}
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={coinType}
							onChange={(e) => setCoinType(e.target.value)}
						>
							{coins.map((coin) => (
								<option key={coin.coinType} value={coin.coinType}>
									{coin.symbol}
								</option>
							))}
						</select>
					)}
				/>
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
					label={`Amount (${selectedCoin.symbol})`}
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
					{isPending ? 'Submitting…' : 'Send'}
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
