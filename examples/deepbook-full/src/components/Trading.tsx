import { useState } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { Card } from '../ui/Card.js';
import { Field } from '../ui/Field.js';
import { deepbookConfig } from '../generated/deepbook-config.js';
import { useSignAndExecute } from '../lib/queries.js';
import { buildLimitOrderTx } from '../lib/transactions.js';
import { parseCoinAmount } from '../lib/format.js';

/** Place a limit order against a margin-enabled pool. The user picks
 *  a pool + side + price + quantity; we route through the DeepBook v3
 *  SDK with the codegen-emitted `deepbookConfig`. */
export function Trading({ self }: { self: string }) {
	const suiClient = useCurrentClient();
	const { mutateAsync, isPending } = useSignAndExecute({
		invalidateKeys: [['balance']],
	});

	const poolKeys = Object.keys(deepbookConfig.pools);
	const [pool, setPool] = useState<string>(poolKeys[0] ?? '');
	const [side, setSide] = useState<'buy' | 'sell'>('buy');
	const [price, setPrice] = useState('3500');
	const [quantity, setQuantity] = useState('1');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			if (!pool) throw new Error('No pool available');
			const tx = buildLimitOrderTx({
				suiClient,
				sender: self,
				poolAlias: pool,
				balanceManagerKey: 'self',
				price: parseCoinAmount(price, 6),
				quantity: parseCoinAmount(quantity, 9),
				isBid: side === 'buy',
			});
			const result = await mutateAsync(tx);
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<Card title="Trading" subtitle="Place a limit order against a margin-enabled pool">
			<form className="space-y-3" onSubmit={onSubmit}>
				<Field
					label="Pool"
					render={(id) => (
						<select
							id={id}
							data-testid="trading-pool"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={pool}
							onChange={(e) => setPool(e.target.value)}
						>
							{poolKeys.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					)}
				/>
				<Field
					label="Side"
					render={(id) => (
						<select
							id={id}
							data-testid="trading-side"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={side}
							onChange={(e) => setSide(e.target.value as typeof side)}
						>
							<option value="buy">Buy</option>
							<option value="sell">Sell</option>
						</select>
					)}
				/>
				<Field
					label="Price"
					render={(id) => (
						<input
							id={id}
							data-testid="trading-price"
							type="text"
							inputMode="decimal"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={price}
							onChange={(e) => setPrice(e.target.value)}
						/>
					)}
				/>
				<Field
					label="Quantity"
					render={(id) => (
						<input
							id={id}
							data-testid="trading-qty"
							type="text"
							inputMode="decimal"
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={quantity}
							onChange={(e) => setQuantity(e.target.value)}
						/>
					)}
				/>
				<button
					data-testid="trading-submit"
					type="submit"
					disabled={isPending}
					className="w-full rounded-md bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
				>
					{isPending ? 'Submitting…' : `Place ${side} order`}
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
