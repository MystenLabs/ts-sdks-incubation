import { deployment } from '../generated/deployment.js';
import { formatStudio, shortAddress } from '../lib/coin.js';
import { useCoinMetadata, useTotalSupply } from '../lib/queries.js';
import { Card } from '@mysten-incubation/devstack/react/ui';

export function CoinHeader() {
	const metadata = useCoinMetadata();
	const supply = useTotalSupply();
	const meta = metadata.data?.coinMetadata ?? null;

	return (
		<Card title="Coin overview" subtitle="On-chain metadata for the deployed package">
			<dl className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 gap-x-6 text-sm">
				<Row label="Name" value={meta?.name ?? '—'} />
				<Row label="Symbol" value={meta?.symbol ?? '—'} />
				<Row label="Decimals" value={meta?.decimals?.toString() ?? '—'} />
				<Row
					label="Total supply"
					value={
						supply.data !== undefined
							? `${formatStudio(supply.data, 2)} ${meta?.symbol ?? ''}`.trim()
							: '—'
					}
				/>
				<Row label="Package" value={shortAddress(deployment.packageId, 6, 6)} mono />
				<Row label="TreasuryCap" value={shortAddress(deployment.treasuryCapId, 6, 6)} mono />
			</dl>
		</Card>
	);
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="flex flex-col">
			<dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
			<dd className={`mt-0.5 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
		</div>
	);
}
