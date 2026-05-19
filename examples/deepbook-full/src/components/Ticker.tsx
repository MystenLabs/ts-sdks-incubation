import { useQuery } from '@tanstack/react-query';
import { Card } from '../ui/Card.js';
import { deepbookConfig } from '../generated/deepbook-config.js';
import { deployment } from '../lib/deployment.js';

interface TickerEntry {
	readonly pool: string;
	readonly lastPrice?: number | string;
	readonly bestBid?: number | string;
	readonly bestAsk?: number | string;
}

/** Best-effort ticker fetch. The deepbook-server REST API exposes
 *  `/ticker` returning per-pool quote rows; field naming has shifted
 *  between snake_case and camelCase across versions, so we accept both. */
async function fetchTicker(restUrl: string): Promise<ReadonlyArray<TickerEntry>> {
	const res = await fetch(`${restUrl}/ticker`);
	if (!res.ok) throw new Error(`/ticker returned ${res.status}`);
	const body = (await res.json()) as Record<
		string,
		{
			last_price?: number | string;
			best_bid?: number | string;
			best_ask?: number | string;
			lastPrice?: number | string;
			bestBid?: number | string;
			bestAsk?: number | string;
		}
	>;
	return Object.entries(body).map(([pool, row]) => ({
		pool,
		lastPrice: row.last_price ?? row.lastPrice,
		bestBid: row.best_bid ?? row.bestBid,
		bestAsk: row.best_ask ?? row.bestAsk,
	}));
}

export function Ticker() {
	const restUrl = deployment.deepbookRestUrl;
	const { data, isLoading, error } = useQuery({
		queryKey: ['ticker', restUrl],
		queryFn: () => (restUrl ? fetchTicker(restUrl) : Promise.resolve([] as TickerEntry[])),
		enabled: restUrl !== undefined,
		refetchInterval: 5_000,
	});

	const rows = data ?? [];
	return (
		<Card title="Ticker" subtitle="deepbook-server /ticker · 5s refresh">
			{restUrl === undefined ? (
				<p className="text-sm text-neutral-500">DeepBook server not available yet.</p>
			) : isLoading ? (
				<p className="text-sm text-neutral-500">Loading…</p>
			) : error ? (
				<p className="text-sm text-red-600 dark:text-red-400">
					Ticker fetch failed: {(error as Error).message}
				</p>
			) : (
				<table className="w-full text-sm">
					<thead className="text-xs uppercase tracking-wide text-neutral-500">
						<tr>
							<th className="text-left py-2">Pool</th>
							<th className="text-right py-2">Last</th>
							<th className="text-right py-2">Best bid</th>
							<th className="text-right py-2">Best ask</th>
						</tr>
					</thead>
					<tbody>
						{Object.keys(deepbookConfig.pools).map((pool) => {
							const row = rows.find((r) => r.pool === pool);
							return (
								<tr
									key={pool}
									data-testid={`ticker-row-${pool}`}
									className="border-t border-neutral-200 dark:border-neutral-800"
								>
									<td className="py-2 font-mono">{pool}</td>
									<td className="py-2 text-right font-mono" data-testid={`ticker-${pool}-last`}>
										{row?.lastPrice ?? '—'}
									</td>
									<td className="py-2 text-right font-mono" data-testid={`ticker-${pool}-bid`}>
										{row?.bestBid ?? '—'}
									</td>
									<td className="py-2 text-right font-mono" data-testid={`ticker-${pool}-ask`}>
										{row?.bestAsk ?? '—'}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</Card>
	);
}
