import { useCurrentAccount } from '@mysten/dapp-kit-react';

import { type CoinSpec, deployment } from '../lib/deployment.js';
import { formatCoin, shortAddress } from '../lib/format.js';
import { useCoinBalance } from '../lib/queries.js';
import { Card } from '@mysten-incubation/devstack/react/ui';

export function Balances() {
	const me = useCurrentAccount();
	const accounts = Object.entries(deployment.accounts) as [string, string][];
	const coins = deployment.coins;

	return (
		<Card title="Balances" subtitle="Seeded accounts and their per-coin holdings">
			<div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
				<table className="w-full text-sm">
					<thead className="bg-neutral-50 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400">
						<tr>
							<th className="text-left px-4 py-2 font-medium">Account</th>
							<th className="text-left px-4 py-2 font-medium">Address</th>
							{coins.map((coin) => (
								<th key={coin.coinType} className="text-right px-4 py-2 font-medium">
									{coin.symbol}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
						{accounts.map(([name, address]) => (
							<BalanceRow
								key={name}
								name={name}
								address={address}
								highlight={me?.address === address}
								coins={coins}
							/>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}

function BalanceRow({
	name,
	address,
	highlight,
	coins,
}: {
	name: string;
	address: string;
	highlight: boolean;
	coins: readonly CoinSpec[];
}) {
	return (
		<tr
			className={
				highlight ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : 'bg-white dark:bg-neutral-900/40'
			}
		>
			<td className="px-4 py-2">
				<span className="font-medium capitalize">{name}</span>
				{highlight && (
					<span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300">
						you
					</span>
				)}
			</td>
			<td className="px-4 py-2 font-mono text-xs">{shortAddress(address, 8, 6)}</td>
			{coins.map((coin) => (
				<BalanceCell key={coin.coinType} address={address} accountName={name} coin={coin} />
			))}
		</tr>
	);
}

function BalanceCell({
	address,
	accountName,
	coin,
}: {
	address: string;
	accountName: string;
	coin: CoinSpec;
}) {
	const balance = useCoinBalance(address, coin.coinType);
	return (
		<td
			className="px-4 py-2 text-right tabular-nums"
			data-testid={`balance-${accountName}-${coin.symbol.toLowerCase()}`}
		>
			{balance.isPending
				? '…'
				: balance.data
					? formatCoin(balance.data.balance, coin.decimals)
					: '—'}
		</td>
	);
}
