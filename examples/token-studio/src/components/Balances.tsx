import { useCurrentAccount } from '@mysten/dapp-kit-react';

import { useConnectedAccounts } from '../lib/accounts.js';
import { formatStudio, shortAddress } from '../lib/coin.js';
import { useCoinBalance } from '../lib/queries.js';
import { Card } from '../ui/Card.js';

export function Balances() {
	const me = useCurrentAccount();
	const accounts = useConnectedAccounts();

	return (
		<Card title="Balances" subtitle="Connected accounts and their current STUDIO holdings">
			<div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
				<table className="w-full text-sm">
					<thead className="bg-neutral-50 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400">
						<tr>
							<th className="text-left px-4 py-2 font-medium">Account</th>
							<th className="text-left px-4 py-2 font-medium">Address</th>
							<th className="text-right px-4 py-2 font-medium">STUDIO</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
						{accounts.map(({ name, address }) => (
							<BalanceRow
								key={address}
								name={name}
								address={address}
								highlight={me?.address === address}
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
}: {
	name: string;
	address: string;
	highlight: boolean;
}) {
	const balance = useCoinBalance(address);
	return (
		<tr
			className={highlight ? 'bg-sky-50/70 dark:bg-sky-950/30' : 'bg-white dark:bg-neutral-900/40'}
		>
			<td className="px-4 py-2">
				<span className="font-medium capitalize">{name}</span>
				{highlight && (
					<span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300">
						you
					</span>
				)}
			</td>
			<td className="px-4 py-2 font-mono text-xs">{shortAddress(address, 8, 6)}</td>
			<td className="px-4 py-2 text-right tabular-nums" data-testid={`balance-${name}-studio`}>
				{balance.isPending ? '…' : balance.data ? formatStudio(balance.data.balance, 2) : '—'}
			</td>
		</tr>
	);
}
