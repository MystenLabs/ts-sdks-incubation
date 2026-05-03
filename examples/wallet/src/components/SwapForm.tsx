import { useId, useMemo, useState } from 'react';

import { deployment, findCoin } from '../generated/deployment.js';
import { parseCoinAmount } from '../lib/format.js';
import { useInvalidateBalances, useSignAndExecute } from '../lib/queries.js';
import { buildDeepbookSwapTx } from '../lib/transactions.js';
import { Card } from './Card.js';

export function SwapForm({ self }: { self: string }) {
	const invalidate = useInvalidateBalances();
	const { mutateAsync, isPending } = useSignAndExecute();

	const pools = deployment.pools;
	const deepbookPackageId = deployment.deepbookPackageId;
	const firstPool = pools[0];

	const [poolAlias, setPoolAlias] = useState<string>(firstPool?.alias ?? '');
	const [direction, setDirection] = useState<'base_to_quote' | 'quote_to_base'>('base_to_quote');
	const [amount, setAmount] = useState('1');
	const [error, setError] = useState<string | null>(null);
	const [lastDigest, setLastDigest] = useState<string | null>(null);

	const pool = useMemo(
		() => pools.find((p) => p.alias === poolAlias) ?? firstPool,
		[pools, poolAlias, firstPool],
	);

	if (!pool || !deepbookPackageId) {
		return (
			<Card title="Swap" subtitle="DeepBook v3 trading">
				<p className="text-sm text-neutral-600 dark:text-neutral-400">
					No pools available. Run{' '}
					<code className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-xs">
						pnpm localnet:up
					</code>{' '}
					to deploy DeepBook and create pools.
				</p>
			</Card>
		);
	}

	const inCoinType = direction === 'base_to_quote' ? pool.baseCoinType : pool.quoteCoinType;
	const outSymbol = direction === 'base_to_quote' ? pool.quoteSymbol : pool.baseSymbol;
	const inSymbol = direction === 'base_to_quote' ? pool.baseSymbol : pool.quoteSymbol;
	const inCoin = findCoin(inCoinType);
	const inDecimals = inCoin?.decimals ?? 9;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		try {
			const raw = parseCoinAmount(amount, inDecimals);
			if (raw <= 0n) throw new Error('Amount must be greater than zero');
			if (!pool) throw new Error('No pool selected');
			if (!deepbookPackageId) throw new Error('DeepBook not deployed');
			const transaction = await buildDeepbookSwapTx({
				sender: self,
				deepbookPackageId,
				poolId: pool.poolId,
				baseCoinType: pool.baseCoinType,
				quoteCoinType: pool.quoteCoinType,
				direction,
				amountIn: raw,
				minOut: 0n,
			});
			const result = await mutateAsync(transaction);
			invalidate();
			setLastDigest(result.digest);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	return (
		<Card
			title="Swap"
			subtitle="Trade against a DeepBook v3 pool — taker side, requires resting liquidity"
		>
			<form className="space-y-3" onSubmit={onSubmit}>
				<Field
					label="Pool"
					render={(id) => (
						<select
							id={id}
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={poolAlias}
							onChange={(e) => setPoolAlias(e.target.value)}
						>
							{pools.map((p) => (
								<option key={p.alias} value={p.alias}>
									{p.baseSymbol} / {p.quoteSymbol}
								</option>
							))}
						</select>
					)}
				/>
				<Field
					label="Direction"
					render={(id) => (
						<select
							id={id}
							className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm"
							value={direction}
							onChange={(e) => setDirection(e.target.value as typeof direction)}
						>
							<option value="base_to_quote">
								Sell {pool.baseSymbol} → {pool.quoteSymbol}
							</option>
							<option value="quote_to_base">
								Sell {pool.quoteSymbol} → {pool.baseSymbol}
							</option>
						</select>
					)}
				/>
				<Field
					label={`Amount in (${inSymbol})`}
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
					className="w-full rounded-md bg-violet-600 hover:bg-violet-700 disabled:bg-neutral-400 text-white text-sm font-medium py-2"
				>
					{isPending ? 'Submitting…' : `Swap ${inSymbol} → ${outSymbol}`}
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

function Field({ label, render }: { label: string; render: (id: string) => React.ReactNode }) {
	const id = useId();
	return (
		<div>
			<label htmlFor={id} className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
				{label}
			</label>
			{render(id)}
		</div>
	);
}
